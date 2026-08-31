// Generate all app icons from a 1024x1024 source image.
// Usage: node scripts/gen-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { PNG } from "pngjs";

const SRC = 1024;
const src = PNG.sync.read(readFileSync("generated-images/A_stunning_catgirl__neko__anim_2026-08-07T03-24-34.png"));

// Check if source has alpha; if not, make near-white transparent.
const hasAlpha = src.data[3] < 255;
if (!hasAlpha) {
  for (let i = 0; i < SRC * SRC; i++) {
    const o = i * 4;
    const avg = (src.data[o] + src.data[o + 1] + src.data[o + 2]) / 3;
    if (avg > 240) {
      src.data[o + 3] = 0;
    }
  }
}

/** Area-average downscale (premultiplied alpha). */
function downscale(srcPng, dstW, dstH) {
  const srcW = srcPng.width;
  const srcH = srcPng.height;
  const rx = srcW / dstW;
  const ry = srcH / dstH;
  const out = new PNG({ width: dstW, height: dstH });
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const x0 = Math.floor(x * rx);
      const x1 = Math.floor((x + 1) * rx);
      const y0 = Math.floor(y * ry);
      const y1 = Math.floor((y + 1) * ry);
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const si = (sy * srcW + sx) * 4;
          const sa = srcPng.data[si + 3] / 255;
          r += srcPng.data[si] * sa;
          g += srcPng.data[si + 1] * sa;
          b += srcPng.data[si + 2] * sa;
          a += sa;
          count++;
        }
      }
      const o = (y * dstW + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round(255 * (a / count));
    }
  }
  return out;
}

function writePng(png, path) {
  writeFileSync(path, PNG.sync.write(png));
  console.log(`  ${path} (${png.width}x${png.height})`);
}

const sizes = [32, 64, 128, 256, 512, 1024];
const squareSizes = [30, 44, 71, 89, 107, 142, 150, 284, 310];

console.log("Generating square icons...");
for (const s of sizes) {
  const png = downscale(src, s, s);
  if (s === 32) writePng(png, "src-tauri/icons/32x32.png");
  if (s === 64) writePng(png, "src-tauri/icons/64x64.png");
  if (s === 128) {
    writePng(png, "src-tauri/icons/128x128.png");
    writePng(png, "src-tauri/icons/128x128@2x.png");
  }
  if (s === 512) writePng(png, "src-tauri/icons/icon.png");
}

console.log("Generating Windows Store logos...");
for (const s of squareSizes) {
  const png = downscale(src, s, s);
  writePng(png, `src-tauri/icons/Square${s}x${s}Logo.png`);
}
// StoreLogo is 50x50
writePng(downscale(src, 50, 50), "src-tauri/icons/StoreLogo.png");

console.log("Generating tray icon (32x32)...");
const traySrc = downscale(src, 32, 32);
writePng(traySrc, "src-tauri/icons/tray.png");

console.log("Done! Run `npx @tauri-apps/cli icon` to regenerate .ico and .icns.");
