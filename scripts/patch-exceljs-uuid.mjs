import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifestPath = resolve("node_modules/exceljs/package.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

if (manifest.name !== "exceljs" || manifest.version !== "4.4.0") {
  throw new Error(`Refusing to patch unexpected ExcelJS package: ${manifest.name}@${manifest.version}`);
}

if (manifest.dependencies?.uuid !== "^8.3.0" && manifest.dependencies?.uuid !== "^11.1.1") {
  throw new Error(`Refusing to patch unexpected ExcelJS uuid range: ${manifest.dependencies?.uuid}`);
}

manifest.dependencies.uuid = "^11.1.1";
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
