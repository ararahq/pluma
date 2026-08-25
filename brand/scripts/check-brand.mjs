import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dist = resolve(root, "brand/dist");
const source = resolve(root, "brand/source");

const expectedFiles = [
  "pluma-symbol.svg",
  "pluma-symbol-reverse.svg",
  "pluma-symbol-mono.svg",
  "pluma-symbol-mono-reverse.svg",
  "pluma-lockup-horizontal.svg",
  "pluma-lockup-horizontal-reverse.svg",
  "pluma-lockup-endorsed-light.svg",
  "pluma-lockup-endorsed-dark.svg",
  "favicon.svg",
  "favicon.ico",
  "favicon-16.png",
  "favicon-32.png",
  "favicon-48.png",
  "favicon-96x96.png",
  "apple-touch-icon.png",
  "web-app-manifest-192x192.png",
  "web-app-manifest-512x512.png",
  "pwa-192.png",
  "pwa-512.png",
  "avatar-512.png",
  "og-default.jpg",
  "site.webmanifest",
];


function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function pngSize(buffer) {
  if (buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("Invalid PNG signature");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

async function exists(path) {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0) throw new Error(`Missing or empty asset: ${path}`);
}

for (const file of expectedFiles) await exists(resolve(dist, file));

const master = await readFile(resolve(source, "pluma-symbol-master.svg"), "utf8");
const approvedPaths = [
  "M21 41H64V52H21ZM21 75H73V86H21ZM21 109H64V120H21Z",
  "M65 31H83L101 55V105L83 129H65L85 100V60Z",
  "M96 75H139V86H96Z",
];
for (const path of approvedPaths) {
  if (!master.includes(path)) throw new Error(`Master geometry drifted: ${path}`);
}
if (/<text|gradient|stroke=/i.test(master)) throw new Error("Master contains text, gradient, or stroke");

const wordmark = await readFile(resolve(source, "pluma-wordmark.svg"), "utf8");
if (/<text/i.test(wordmark)) throw new Error("Wordmark must remain outlined vector artwork");

const arara = [
  ["logo-horizontal-light.svg", "980e46af269249e9cea15d909b8e432e2a43992952fa2cdd340d5d2428d6d468"],
  ["logo-horizontal-dark.svg", "6380e651a56e19cd862c12573ccb8e9d4baca2238bf3ca42d8f31f59f0bedd0f"],
];
for (const [file, expectedHash] of arara) {
  const buffer = await readFile(resolve(source, "ararahq", file));
  const normalized = Buffer.from(buffer.toString("utf8").trimEnd());
  if (sha256(normalized) !== expectedHash) throw new Error(`Official AraraHQ artwork drifted: ${file}`);
}

const rasterSizes = [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["favicon-48.png", 48],
  ["favicon-96x96.png", 96],
  ["apple-touch-icon.png", 180],
  ["web-app-manifest-192x192.png", 192],
  ["web-app-manifest-512x512.png", 512],
  ["avatar-512.png", 512],
];
for (const [file, expectedSize] of rasterSizes) {
  const [width, height] = pngSize(await readFile(resolve(dist, file)));
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${file} is ${width}x${height}; expected ${expectedSize}x${expectedSize}`);
  }
}

const ico = await readFile(resolve(dist, "favicon.ico"));
if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 3) {
  throw new Error("favicon.ico must contain three icon entries");
}

const manifest = JSON.parse(await readFile(resolve(dist, "site.webmanifest"), "utf8"));
if (manifest.name !== "Pluma" || manifest.icons?.length !== 2) {
  throw new Error("Manifest name or icon contract drifted");
}

console.log(`Pluma brand check passed: ${expectedFiles.length} generated assets.`);
