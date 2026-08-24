import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { AppError } from "../errors.js";

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
}

function inV4(address: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function normalizedV6(address: string): string {
  return address.toLowerCase().split("%")[0]!;
}

// Keep this public-only policy aligned with src/read/html/fetch.ts. The Cloud
// client additionally pins the validated address for the actual connection.
const PUBLIC_V6 = new BlockList();
PUBLIC_V6.addSubnet("2000::", 3, "ipv6");
const BLOCKED_V6 = new BlockList();
BLOCKED_V6.addSubnet("2001::", 32, "ipv6");
BLOCKED_V6.addSubnet("2001:2::", 48, "ipv6");
BLOCKED_V6.addSubnet("2001:10::", 28, "ipv6");
BLOCKED_V6.addSubnet("2001:20::", 28, "ipv6");
BLOCKED_V6.addSubnet("2001:db8::", 32, "ipv6");
BLOCKED_V6.addSubnet("2002::", 16, "ipv6");
BLOCKED_V6.addSubnet("3fff::", 20, "ipv6");

function mappedV4(address: string): string | null {
  const normalized = normalizedV6(address);
  const match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (match) return match[1]!;
  const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const value = (Number.parseInt(hex[1]!, 16) << 16) | Number.parseInt(hex[2]!, 16);
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.some(([base, prefix]) => inV4(address, base, prefix));
  if (family !== 6) return false;
  const mapped = mappedV4(address);
  if (mapped) return isPublicAddress(mapped);
  const value = normalizedV6(address);
  return PUBLIC_V6.check(value, "ipv6") && !BLOCKED_V6.check(value, "ipv6");
}

export function normalizeRemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("unsafe_url", "URL is invalid", 400);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("unsafe_url", "Only HTTP and HTTPS URLs are supported", 400);
  if (url.username || url.password) throw new AppError("unsafe_url", "URLs containing credentials are not supported", 400);
  if (!url.hostname || url.hostname.endsWith(".")) throw new AppError("unsafe_url", "URL hostname is invalid", 400);
  url.hash = "";
  return url;
}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export interface LookupAddress { address: string; family: number }
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export async function resolvePublicTarget(raw: string | URL, resolver: Resolver = defaultResolver): Promise<ResolvedTarget> {
  const url = typeof raw === "string" ? normalizeRemoteUrl(raw) : normalizeRemoteUrl(raw.href);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname).catch((cause) => { throw new AppError("unsafe_url", "URL hostname could not be resolved", 400, { cause }); });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new AppError("unsafe_url", "URL resolves to a blocked network", 400);
  }
  return { url, address: addresses[0]!.address, family: addresses[0]!.family as 4 | 6 };
}
