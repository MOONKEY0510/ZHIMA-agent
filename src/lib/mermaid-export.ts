/**
 * Diagram export (画图模块): SVG (vector) and high-DPI PNG.
 *
 * Both go through the native save dialog, matching the other export flows
 * (`lib/export.ts`, `lib/export-image.ts`).
 */
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { fileStamp } from "./export-image";
import type { DiagramTheme } from "./mermaid-theme";

/** Save the rendered diagram as a standalone vector SVG file. */
export async function exportDiagramSvg(svg: string): Promise<boolean> {
  const filePath = await save({
    title: "导出流程图 (SVG)",
    defaultPath: `流程图-${fileStamp()}.svg`,
    filters: [{ name: "SVG 矢量图", extensions: ["svg"] }],
  });
  if (!filePath) return false;
  await writeTextFile(filePath, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}`);
  return true;
}

/** Rasterize the diagram at `scale`× and save it as a PNG. */
export async function exportDiagramPng(
  svg: string,
  theme: DiagramTheme,
  scale = 2,
): Promise<boolean> {
  const filePath = await save({
    title: "导出流程图 (PNG)",
    defaultPath: `流程图-${fileStamp()}.png`,
    filters: [{ name: "PNG 图片", extensions: ["png"] }],
  });
  if (!filePath) return false;

  const blob = await svgToPngBlob(svg, scale, theme.canvas);
  await writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

/** SVG string → PNG blob via an offscreen canvas. */
async function svgToPngBlob(
  svg: string,
  scale: number,
  background: string,
): Promise<Blob> {
  const { width, height } = svgSize(svg);
  const sized = withFixedSize(svg, width, height);
  const url = URL.createObjectURL(
    new Blob([sized], { type: "image/svg+xml;charset=utf-8" }),
  );
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建绘图上下文");

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("PNG 导出失败"))),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("SVG 图像加载失败"));
    image.src = src;
  });
}

/** Read the SVG's intrinsic size from its viewBox (fallback: width/height). */
function svgSize(svg: string): { width: number; height: number } {
  const viewBox = /viewBox="([^"]+)"/.exec(svg);
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const w = /width="([\d.]+)"/.exec(svg);
  const h = /height="([\d.]+)"/.exec(svg);
  return {
    width: w ? Number(w[1]) : 800,
    height: h ? Number(h[1]) : 600,
  };
}

/**
 * Pin explicit `width` / `height` attributes so `<img>`-based rasterization
 * has a deterministic size (mermaid emits `width="100%"` + `max-width`).
 */
function withFixedSize(svg: string, width: number, height: number): string {
  return svg.replace(/<svg([^>]*)>/, (_match, attrs: string) => {
    const cleaned = attrs
      .replace(/\s(?:width|height)="[^"]*"/g, "")
      .replace(/\sstyle="[^"]*"/g, "");
    return `<svg${cleaned} width="${width}" height="${height}">`;
  });
}
