/**
 * Diagram theming — maps application themes and built-in style presets to
 * Mermaid `themeVariables`.
 *
 * Two layers of colour sources:
 * - `auto` reads the live CSS custom properties (`--cf-*`, `--hl-*`) from
 *   `document.documentElement`, so diagrams follow the active app theme
 *   (light / dark / warm / rose / spring) including OS dark-mode switches;
 * - `tech`, `morandi` and `handdrawn` are standalone curated palettes that
 *   look the same regardless of the app theme.
 *
 * All styles share one mapping function so flowchart / sequence / state /
 * class / gantt / pie / git diagrams stay visually consistent.
 */
import type { MermaidConfig } from "mermaid";

export const DIAGRAM_STYLES = ["auto", "tech", "morandi", "handdrawn"] as const;
export type DiagramStyle = (typeof DIAGRAM_STYLES)[number];

export const DIAGRAM_STYLE_OPTIONS: { value: DiagramStyle; label: string }[] = [
  { value: "auto", label: "跟随主题" },
  { value: "tech", label: "科技蓝" },
  { value: "morandi", label: "莫兰迪" },
  { value: "handdrawn", label: "手绘风" },
];

/** CJK-first stack: keeps Chinese labels elegant in both render and export. */
const FONT_FAMILY =
  '"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif';

/* ------------------------------------------------------------------ */
/* colour helpers                                                      */
/* ------------------------------------------------------------------ */

function parseHex(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** Linear blend of two hex colours: `t = 0` keeps `a`, `t = 1` returns `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const ch = (i: number) => Math.round(ca[i] + (cb[i] - ca[i]) * t);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/** Hex colour + alpha → `rgba(...)` (falls back to the input when unparsable). */
export function alpha(color: string, a: number): string {
  const c = parseHex(color);
  if (!c) return color;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
}

function hexToHsl(hex: string): [number, number, number] | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return (
    "#" +
    rgb
      .map((v) =>
        Math.round((v + m) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

/**
 * Build a harmonious, well-separated 8-colour series palette around the
 * accent hue.  Used for pie / git / class-coloured diagrams where a single
 * accent colour would look flat.
 */
export function seriesPalette(seed: string, dark: boolean, count = 8): string[] {
  const hsl = hexToHsl(seed);
  const hue = hsl ? hsl[0] : 218;
  const sat = Math.min(Math.max(hsl && hsl[1] > 0.08 ? hsl[1] : 0.55, 0.42), 0.72);
  const baseL = dark ? 0.64 : 0.52;
  return Array.from({ length: count }, (_, i) => {
    const light = Math.min(Math.max(baseL + (i % 2 === 0 ? 0 : 0.07), 0.3), 0.75);
    return hslToHex(hue + 22 + i * (360 / count), sat, light);
  });
}

/** Perceived-luminance check, used to pick readable overlay text colours. */
export function isLightColor(color: string): boolean {
  const rgb = parseHex(color);
  if (!rgb) return true;
  const [r, g, b] = rgb;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** Read a CSS custom property from the document root. */
function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/* ------------------------------------------------------------------ */
/* palette → mermaid theme variables                                   */
/* ------------------------------------------------------------------ */

/** Base palette every style provides; the mapper derives the rest. */
interface BasePalette {
  dark: boolean;
  /** Card / canvas background behind the diagram. */
  panel: string;
  text: string;
  text2: string;
  border: string;
  accent: string;
  accentFg: string;
  success: string;
  danger: string;
  highlight: string;
  series: string[];
}

/** Full rendering recipe for one diagram style. */
export interface DiagramTheme {
  config: MermaidConfig;
  /** Optional drop-shadow applied to nodes after rendering. */
  filter: string;
  /** Opaque background used for the fullscreen view and PNG export. */
  canvas: string;
}

function themeVariables(p: BasePalette): Record<string, string> {
  const nodeFill = mix(p.panel, p.accent, p.dark ? 0.16 : 0.08);
  const nodeBorder = mix(p.accent, p.border, 0.55);
  const line = mix(p.text2, p.border, 0.35);
  const series = p.series;

  const vars: Record<string, string> = {
    darkMode: String(p.dark),
    background: "transparent",
    fontFamily: FONT_FAMILY,
    fontSize: "14px",

    primaryColor: nodeFill,
    primaryTextColor: p.text,
    primaryBorderColor: nodeBorder,
    secondaryColor: mix(p.panel, p.success, p.dark ? 0.2 : 0.1),
    secondaryTextColor: p.text,
    secondaryBorderColor: mix(p.success, p.border, 0.5),
    tertiaryColor: mix(p.panel, p.highlight, p.dark ? 0.2 : 0.1),
    tertiaryTextColor: p.text,
    tertiaryBorderColor: mix(p.highlight, p.border, 0.5),

    lineColor: line,
    textColor: p.text,

    /* flowchart & common */
    mainBkg: nodeFill,
    nodeBorder,
    nodeTextColor: p.text,
    clusterBkg: alpha(p.accent, p.dark ? 0.1 : 0.05),
    clusterBorder: alpha(p.accent, 0.3),
    edgeLabelBackground: p.panel,
    defaultLinkColor: line,
    titleColor: p.text,

    /* sequence */
    actorBkg: nodeFill,
    actorBorder: nodeBorder,
    actorTextColor: p.text,
    actorLineColor: mix(p.text2, p.border, 0.3),
    signalColor: p.text,
    signalTextColor: p.text2,
    labelBoxBkgColor: nodeFill,
    labelBoxBorderColor: nodeBorder,
    labelTextColor: p.text,
    loopTextColor: p.text,
    noteBkgColor: mix(p.panel, p.highlight, p.dark ? 0.18 : 0.1),
    noteBorderColor: mix(p.highlight, p.border, 0.45),
    noteTextColor: p.text,
    activationBkgColor: mix(p.panel, p.accent, 0.22),
    activationBorderColor: nodeBorder,
    sequenceNumberColor: p.accentFg,

    /* state / class */
    labelBackgroundColor: p.panel,
    classText: p.text,

    /* gantt */
    sectionBkgColor: alpha(p.accent, 0.06),
    altSectionBkgColor: "transparent",
    taskBkgColor: nodeFill,
    taskBorderColor: nodeBorder,
    taskTextColor: p.text,
    taskTextOutsideColor: p.text,
    taskTextLightColor: p.text,
    taskTextDarkColor: p.text,
    activeTaskBkgColor: mix(p.panel, p.accent, 0.3),
    activeTaskBorderColor: nodeBorder,
    doneTaskBkgColor: mix(p.panel, p.text2, 0.15),
    doneTaskBorderColor: p.border,
    gridColor: alpha(p.text2, 0.2),
    todayLineColor: p.danger,

    /* er */
    attributeBackgroundColorOdd: mix(p.panel, p.accent, p.dark ? 0.08 : 0.04),
    attributeBackgroundColorEven: "transparent",

    /* misc */
    errorBkgColor: alpha(p.danger, 0.15),
    errorTextColor: p.danger,
  };

  // pie1..pie12 and git0..git7 rotate through the series palette.
  for (let i = 0; i < 12; i += 1) {
    vars[`pie${i + 1}`] = series[i % series.length];
  }
  for (let i = 0; i < 8; i += 1) {
    vars[`git${i}`] = series[i % series.length];
    vars[`gitBranchLabel${i}`] = "#ffffff";
  }

  return vars;
}

/* ------------------------------------------------------------------ */
/* styles                                                              */
/* ------------------------------------------------------------------ */

/** `auto` — follow the live application theme. */
function autoDiagramTheme(resolvedTheme: string): DiagramTheme {
  const dark = resolvedTheme === "dark";
  const panel = cssVar("--cf-panel", dark ? "#212121" : "#ffffff");
  const text = cssVar("--cf-text", dark ? "#ececec" : "#202123");
  const text2 = cssVar("--cf-text-2", dark ? "#a3a3a3" : "#6b7280");
  const border = cssVar("--cf-border", dark ? "#3a3a3a" : "#e5e7eb");
  const accent = cssVar("--cf-accent", dark ? "#ececec" : "#111827");
  const accentFg = cssVar("--cf-accent-fg", dark ? "#171717" : "#ffffff");
  const success = cssVar("--cf-success", "#16865c");
  const danger = cssVar("--cf-danger", "#c2413b");
  const highlight = cssVar("--hl-number", "#953800");

  const palette: BasePalette = {
    dark,
    panel,
    text,
    text2,
    border,
    accent,
    accentFg,
    success,
    danger,
    highlight,
    series: seriesPalette(accent, dark),
  };

  return {
    config: {
      theme: "base",
      themeVariables: themeVariables(palette),
    },
    filter: dark
      ? "drop-shadow(0 2px 5px rgba(0,0,0,0.45))"
      : "drop-shadow(0 1.5px 3px rgba(15,23,42,0.14))",
    canvas: panel,
  };
}

/** `tech` — dark navy canvas, glowing blue edges (PPT-grade look). */
function techDiagramTheme(): DiagramTheme {
  const series = [
    "#3b82f6",
    "#22d3ee",
    "#818cf8",
    "#34d399",
    "#f472b6",
    "#fbbf24",
    "#a78bfa",
    "#38bdf8",
  ];
  const palette: BasePalette = {
    dark: true,
    panel: "#0d1424",
    text: "#dbeafe",
    text2: "#8ea8c9",
    border: "#2a3b57",
    accent: "#60a5fa",
    accentFg: "#0d1424",
    success: "#34d399",
    danger: "#f87171",
    highlight: "#fbbf24",
    series,
  };

  return {
    config: {
      theme: "base",
      themeVariables: {
        ...themeVariables(palette),
        background: "#0d1424",
        edgeLabelBackground: "#0d1424",
      },
    },
    filter: "drop-shadow(0 0 7px rgba(59,130,246,0.45))",
    canvas: "#0d1424",
  };
}

/** `morandi` — low-saturation muted tones, calm editorial feel. */
function morandiDiagramTheme(): DiagramTheme {
  const series = [
    "#a8b5a2",
    "#c7b8a1",
    "#9ba7b0",
    "#b8a6b0",
    "#c9c2a8",
    "#8fa3a8",
    "#bfa89b",
    "#a7a09a",
  ];
  const palette: BasePalette = {
    dark: false,
    panel: "#faf9f6",
    text: "#4a453c",
    text2: "#857f72",
    border: "#ddd8cd",
    accent: "#8c9a86",
    accentFg: "#ffffff",
    success: "#7d9b76",
    danger: "#b08585",
    highlight: "#b3a176",
    series,
  };

  return {
    config: {
      theme: "base",
      themeVariables: {
        ...themeVariables(palette),
        background: "#faf9f6",
        edgeLabelBackground: "#faf9f6",
      },
    },
    filter: "drop-shadow(0 2px 4px rgba(90,80,60,0.16))",
    canvas: "#faf9f6",
  };
}

/** `handdrawn` — sketch look on warm paper. */
function handdrawnDiagramTheme(): DiagramTheme {
  const series = [
    "#b08968",
    "#7f9183",
    "#8e7cc3",
    "#c4756f",
    "#a3a25f",
    "#5f8fa3",
    "#b58aa5",
    "#8a8375",
  ];
  const palette: BasePalette = {
    dark: false,
    panel: "#fffdf5",
    text: "#3a3226",
    text2: "#7a6a52",
    border: "#d9cdb4",
    accent: "#6b5b3e",
    accentFg: "#fffdf5",
    success: "#6f8a5c",
    danger: "#b3553f",
    highlight: "#b08a3e",
    series,
  };

  return {
    config: {
      theme: "base",
      look: "handDrawn",
      handDrawnSeed: 7,
      themeVariables: {
        ...themeVariables(palette),
        background: "#fffdf5",
        edgeLabelBackground: "#fffdf5",
      },
    },
    filter: "none",
    canvas: "#fffdf5",
  };
}

/**
 * Resolve a diagram style into a complete Mermaid config.
 *
 * `resolvedTheme` is the concrete theme currently applied to the document
 * (`light` / `dark` / `warm` / `rose` / `spring`); only `auto` uses it.
 */
export function diagramTheme(
  style: DiagramStyle,
  resolvedTheme: string,
): DiagramTheme {
  switch (style) {
    case "tech":
      return techDiagramTheme();
    case "morandi":
      return morandiDiagramTheme();
    case "handdrawn":
      return handdrawnDiagramTheme();
    default:
      return autoDiagramTheme(resolvedTheme);
  }
}

/**
 * CSS injected into the rendered SVG: soft per-node shadows so diagrams do
 * not look flat, plus slightly rounded, calmer edges.
 */
export function diagramSvgStyle(filter: string): string {
  const shadow = filter && filter !== "none" ? filter : "none";
  return [
    "/* cf-diagram */",
    `.node rect, .node circle, .node polygon, .node path { filter: ${shadow}; }`,
    ".edgeLabel rect { opacity: 0.85; }",
    ".cluster rect { rx: 10; ry: 10; }",
  ].join("\n");
}
