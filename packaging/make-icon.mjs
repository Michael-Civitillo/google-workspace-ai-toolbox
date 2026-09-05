#!/usr/bin/env node
/**
 * Render public/logo.svg into packaging/assets/icon.ico, the icon Windows
 * shows for the executable and in the taskbar.
 *
 * The result is committed, so this only needs re-running when the logo
 * changes. sharp comes along with Next.js, and the ICO container is written
 * here rather than pulling in another dependency for forty lines of format:
 * an ICO is a small header, one directory entry per size, then the images
 * themselves - which since Vista may be PNG data verbatim.
 *
 * Usage: npm run package:icon
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packagingDir, "..");
const source = path.join(repoRoot, "public", "logo.svg");
const target = path.join(packagingDir, "assets", "icon.ico");

/** Windows picks the nearest size; these cover taskbar through to Explorer tiles. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(images) {
  const HEADER = 6;
  const ENTRY = 16;
  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(ENTRY * images.length);
  let offset = HEADER + ENTRY * images.length;

  images.forEach(({ size, data }, index) => {
    const at = index * ENTRY;
    // 256 is stored as 0: the field is one byte wide.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0); // width
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette colours (0 = truecolour)
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

if (!fs.existsSync(source)) {
  console.error(`make-icon: no logo at ${source}`);
  process.exit(1);
}

const images = [];
for (const size of SIZES) {
  const data = await sharp(source, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  images.push({ size, data });
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, buildIco(images));
console.log(
  `make-icon: wrote ${path.relative(repoRoot, target)} ` +
    `(${SIZES.join(", ")} px, ${(fs.statSync(target).size / 1024).toFixed(1)} KB)`
);
