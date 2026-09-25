/**
 * Mermaid rendering core (画图模块).
 *
 * The mermaid bundle (~1 MB) is loaded lazily the first time a `mermaid` code
 * block appears — messages without diagrams never pay for it (same pattern as
 * the KaTeX chunk in `components/markdown`).
 *
 * ELK (~1.4 MB) is loaded only for diagrams large enough to benefit from its
 * edge routing. Loading it for every diagram made a single small flowchart
 * fetch more than the whole app bundle; the built-in layout handles the common
 * cases, and a wrong guess here costs layout quality, never correctness.
 */
import type { MermaidConfig } from "mermaid";
import { diagramSvgStyle, type DiagramTheme } from "./mermaid-theme";

let modulePromise: Promise<typeof import("mermaid")> | null = null;
let elkPromise: Promise<boolean> | null = null;

/** Load mermaid exactly once. */
function loadMermaid(): Promise<typeof import("mermaid")> {
  modulePromise ??= import("mermaid");
  return modulePromise;
}

/** Load and register ELK once; `false` means "stick to the default layout". */
function loadElk(): Promise<boolean> {
  elkPromise ??= (async () => {
    try {
      const [elk, mermaid] = await Promise.all([
        import("@mermaid-js/layout-elk"),
        loadMermaid(),
      ]);
      mermaid.default.registerLayoutLoaders(elk.default);
      return true;
    } catch (error) {
      // Diagrams still render with the default layout engine.
      console.warn("ELK 布局引擎加载失败，已回退到默认布局:", error);
      return false;
    }
  })();
  return elkPromise;
}

/**
 * Whether a diagram is complex enough that ELK is worth its download.
 *
 * Deliberately a cheap text heuristic: the inputs are trusted-ish model output
 * and the only cost of guessing wrong is layout quality.
 */
export function wantsElk(code: string): boolean {
  const lines = code.split("\n").filter((line) => line.trim().length > 0).length;
  const edges = (code.match(/-->|---|==>|-\.->|-->>|--x|--o/g) ?? []).length;
  return lines >= 24 || edges >= 18;
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
  const useElk = wantsElk(code) && (await loadElk());
  const config: MermaidConfig = {
    startOnLoad: false,
    securityLevel: "strict",
    ...theme.config,
    ...(useElk ? { layout: "elk" } : {}),
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
