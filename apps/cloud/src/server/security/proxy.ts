import { isIP } from "node:net";

export function resolveClientIp(direct: string, forwardedFor: string | undefined, trustedProxyHops: number): string {
  if (trustedProxyHops <= 0) return direct;
  const chain = forwardedFor?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  const candidate = chain.at(-trustedProxyHops);
  return candidate && isIP(candidate) !== 0 ? candidate : direct;
}
