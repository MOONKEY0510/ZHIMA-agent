/**
 * Mermaid rendering core (画图模块).
 *
 * The mermaid bundle (~1 MB) and the ELK layout engine are loaded lazily the
 * first time a `mermaid` code block appears — messages without diagrams never
 * pay for them (same pattern as the KaTeX chunk in `components/markdown`).
 *
 * ELK produces noticeably cleaner edge routing on larger flowcharts; mermaid
 * silently falls back to its default layout for diagram types ELK does not
 * support, so it is safe to leave enabled.
 */
import type { MermaidConfig } from "mermaid";
import { diagramSvgStyle, type DiagramTheme } from "./mermaid-theme";

let modulePromise: Promise<typeof import("mermaid")> | null = null;
let elkAvailable = false;

/** Load mermaid (and the ELK layout loader) exactly once. */
function loadMermaid(): Promise<typeof import("mermaid")> {
  modulePromise ??= (async () => {
    const mermaid = await import("mermaid");
    try {
      const elk = await import("@mermaid-js/layout-elk");
      mermaid.default.registerLayoutLoaders(elk.default);
      elkAvailable = true;
    } catch (error) {
      // Diagrams still render with the default layout engine.
      console.warn("ELK 布局引擎加载失败，已回退到默认布局:", error);
    }
    return mermaid;
  })();
  return modulePromise;
}

let renderSeq = 0;

/**
 * Render one diagram definition into an SVG string.
 *
 * Throws an `Error` with mermaid's parse message when the code is invalid;
 * callers show the source plus the message instead of a broken picture.
 */
export async function renderMermaidDiagram(
  code: string,
  theme: DiagramTheme,
): Promise<string> {
  const mermaid = (await loadMermaid()).default;
  const config: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    ...theme.config,
    ...(elkAvailable ? { layout: "elk" } : {}),
    flowchart: {
      htmlLabels: false,
      curve: "basis",
      padding: 12,
      nodeSpacing: 45,
      rankSpacing: 55,
      useMaxWidth: true,
    },
    sequence: { useMaxWidth: true, wrap: true },
  };
  mermaid.initialize(config);

  const id = `cf-mmd-${(renderSeq += 1)}`;
  try {
    const { svg } = await mermaid.render(id, code);
    return injectStyle(svg, theme.filter);
  } catch (error) {
    // On failure mermaid leaves its measurement element behind; clean it up.
    document.getElementById(`d${id}`)?.remove();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** Insert the beautification stylesheet right after the `<svg>` open tag. */
function injectStyle(svg: string, filter: string): string {
  return svg.replace(
    /<svg([^>]*)>/,
    `<svg$1><style>${diagramSvgStyle(filter)}</style>`,
  );
}
