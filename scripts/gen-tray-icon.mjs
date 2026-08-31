// Generates a transparent 32x32 tray icon from the square app artwork:
// white background becomes transparent (feathered), then block-downscaled.
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const SRC = 1024;
const DST = 32;
const RATIO = SRC / DST;

const src = PNG.sync.read(readFileSync("assets/icon-source.png"));

// 1) Feather alpha: pure white -> fully transparent, colored -> opaque.
const alpha = new Float64Array(SRC * SRC);
for (let i = 0; i < SRC * SRC; i++) {
  const o = i * 4;
  const avg = (src.data[o] + src.data[o + 1] + src.data[o + 2]) / 3;
  alpha[i] = Math.max(0, Math.min(255, (255 - avg) * 4));
}

// 2) Area-average downscale with premultiplied color.
const out = new PNG({ width: DST, height: DST });
for (let y = 0; y < DST; y++) {
  for (let x = 0; x < DST; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < RATIO; dy++) {
      for (let dx = 0; dx < RATIO; dx++) {
        const si = (Math.floor(y * RATIO + dy) * SRC + Math.floor(x * RATIO + dx)) * 4;
        const sa = alpha[(si / 4) | 0] / 255;
        r += src.data[si] * sa;
        g += src.data[si + 1] * sa;
        b += src.data[si + 2] * sa;
        a += sa;
      }
    }
    const n = RATIO * RATIO;
    const o = (y * DST + x) * 4;
    if (a > 0) {
      out.data[o] = Math.round(r / a);
      out.data[o + 1] = Math.round(g / a);
      out.data[o + 2] = Math.round(b / a);
    } else {
      out.data[o] = out.data[o + 1] = out.data[o + 2] = 0;
    }
    out.data[o + 3] = Math.round(255 * (a / n));
  }
}

writeFileSync("src-tauri/icons/tray.png", PNG.sync.write(out));
console.log("tray.png written:", DST, "x", DST);
