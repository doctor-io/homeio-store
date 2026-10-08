// Turns a PNG screenshot into Apps/<id>/screenshots/<n>.webp (1280 px wide).
// Run: node scripts/to-webp.mjs <in.png> <appId> <n>
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const [input, appId, n] = process.argv.slice(2);
if (!input || !appId || !n) {
  console.error("usage: node scripts/to-webp.mjs <in.png> <appId> <n>");
  process.exit(2);
}
const dir = path.resolve(import.meta.dirname, "..", "Apps", appId, "screenshots");
mkdirSync(dir, { recursive: true });
const out = path.join(dir, `${n}.webp`);
await sharp(input).resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 82 }).toFile(out);
console.log(out);
