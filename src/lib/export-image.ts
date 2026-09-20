import { toPng } from "html-to-image";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

/**
 * Image export (P1-11.2): render the conversation pane to a PNG.
 *
 * html-to-image reads the live DOM (inline styles, computed colours), so the
 * snapshot matches what the user sees — including the active theme and the
 * collapsed/expanded state of code blocks.
 */

/** `YYYYMMDD-HHMM` stamp used in default file names. */
export function fileStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

/** Decode the payload of a `data:image/png;base64,…` URL. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Snapshot `node` and ask the user where to save it.  Returns false when the
 * save dialog is cancelled.
 *
 * The full scrollable size is captured (not just the visible viewport), so
 * callers should expand any virtualised list first (see `withExpandedList`).
 */
export async function exportNodeAsImage(node: HTMLElement): Promise<boolean> {
  // Web fonts (and KaTeX glyphs) must be ready or the snapshot shows fallbacks.
  await document.fonts?.ready;

  const background = getComputedStyle(document.body).backgroundColor;
  const dataUrl = await toPng(node, {
    pixelRatio: 2,
    cacheBust: true,
    width: Math.max(node.scrollWidth, node.clientWidth),
    height: Math.max(node.scrollHeight, node.clientHeight),
    style: { overflow: "visible" },
    backgroundColor: background && background !== "rgba(0, 0, 0, 0)" ? background : "#ffffff",
  });

  const filePath = await save({
    title: "导出对话为图片",
    defaultPath: `对话-${fileStamp()}.png`,
    filters: [{ name: "PNG 图片", extensions: ["png"] }],
  });
  if (!filePath) return false;

  const base64 = dataUrl.split(",")[1] ?? "";
  await writeFile(filePath, base64ToBytes(base64));
  return true;
}
