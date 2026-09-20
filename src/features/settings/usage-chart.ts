import type { DailyUsage, ModelDailyUsage } from "../../services/usage-api";

/**
 * Pure helpers behind the usage panel: number formatting, streaks, the
 * activity heatmap, per-model trend series and donut geometry.  Kept free of
 * React so every number can be unit-tested.
 */

/* ------------------------------------------------------------------------ */
/* Formatting                                                                */
/* ------------------------------------------------------------------------ */

/** Drop trailing zeros from a fixed-point string ("12.30" → "12.3"). */
function trimZeros(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/**
 * Compact token label in the 万 / 亿 scale used across the panel:
 * `999` → "999", `12_345` → "1.2 万", `360_000_000` → "3.6 亿".
 */
export function formatTokens(value: number): string {
  const n = Math.max(0, value);
  if (n < 10_000) return String(Math.round(n));
  if (n < 100_000_000) return `${trimZeros((n / 10_000).toFixed(1))} 万`;
  return `${trimZeros((n / 100_000_000).toFixed(1))} 亿`;
}

/** Exact count with thousands separators ("1,234"). */
export function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

/** Percentage for the donut legend: "82%" when large, "2.2%" when small. */
export function formatPercent(value: number): string {
  if (value >= 10) return `${Math.round(value)}%`;
  return `${trimZeros(value.toFixed(1))}%`;
}

/** Human duration: "3 小时 17 分" / "45 分钟" / "23 秒". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${totalSeconds} 秒`;
}

/** `YYYY-MM-DD` of a local Date (matches the backend's `localtime` buckets). */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parse a `YYYY-MM-DD` key into a local Date. */
export function parseDayKey(key: string): Date | null {
  const [year, month, date] = key.split("-").map(Number);
  if (!year || !month || !date) return null;
  return new Date(year, month - 1, date);
}

/** "2026-09-20" → "9月20日" for the x-axis. */
export function formatDayLabel(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
}

/** Local-date arithmetic that survives DST shifts. */
function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/* ------------------------------------------------------------------------ */
/* Axis maths                                                                */
/* ------------------------------------------------------------------------ */

/** Round a value up to a pleasant axis maximum (1 / 2 / 5 × 10ⁿ). */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const normalized = value / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

/**
 * Indexes of the x-axis labels to draw: both ends plus evenly spaced stops in
 * between, so the axis stays readable at any series length.
 */
export function axisLabelIndexes(count: number, maxLabels = 5): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const indexes = new Set<number>();
  for (let i = 0; i < maxLabels; i += 1) {
    indexes.add(Math.round((i / (maxLabels - 1)) * (count - 1)));
  }
  return [...indexes].sort((a, b) => a - b);
}

/* ------------------------------------------------------------------------ */
/* Streaks                                                                   */
/* ------------------------------------------------------------------------ */

export interface Streaks {
  /** Consecutive active days ending today; 0 when today has no activity. */
  current: number;
  /** Longest run of consecutive active days on record. */
  longest: number;
}

/**
 * Consecutive-day streaks over a list of active `YYYY-MM-DD` days
 * (duplicates tolerated, order irrelevant).
 */
export function computeStreaks(activeDays: string[], today = new Date()): Streaks {
  const unique = [...new Set(activeDays)].sort();
  let longest = 0;
  let run = 0;
  let previous: Date | null = null;
  for (const key of unique) {
    const date = parseDayKey(key);
    if (!date) continue;
    run = previous && dayKey(addDays(previous, 1)) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }

  const active = new Set(unique);
  let current = 0;
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  while (active.has(dayKey(cursor))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}

/* ------------------------------------------------------------------------ */
/* Activity heatmap                                                          */
/* ------------------------------------------------------------------------ */

export type HeatmapMode = "daily" | "weekly" | "cumulative";

export interface HeatmapCell {
  /** `YYYY-MM-DD` (local). */
  day: string;
  weekIndex: number;
  /** 0 = Monday … 6 = Sunday. */
  weekdayIndex: number;
  /** Value for the current mode (tokens). */
  value: number;
  /** 0 (empty) … 4 (busiest) for the colour scale. */
  level: number;
}

export interface Heatmap {
  cells: HeatmapCell[];
  weeks: number;
  monthLabels: { weekIndex: number; label: string }[];
}

/**
 * Build a GitHub-style contribution grid for the last 52 weeks.
 *
 * The window is aligned back to a Monday so rows are whole weeks; `mode`
 * decides what a cell's colour means — that day's tokens, its week's total,
 * or the running total up to that day.
 */
export function buildHeatmap(
  daily: DailyUsage[],
  mode: HeatmapMode,
  today = new Date(),
): Heatmap {
  const totals = new Map<string, number>();
  for (const entry of daily) {
    totals.set(entry.day, entry.inputTokens + entry.outputTokens);
  }

  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = addDays(end, -364);
  // Align back to Monday: getDay() is Sunday-based.
  const startOffset = (start.getDay() + 6) % 7;
  const gridStart = addDays(start, -startOffset);

  const days: Date[] = [];
  for (let cursor = gridStart; cursor <= end; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  const weeks = Math.max(1, Math.ceil(days.length / 7));
  const dailyValues = days.map((date) => totals.get(dayKey(date)) ?? 0);

  let display = dailyValues;
  if (mode === "weekly") {
    const weekTotals = new Array(weeks).fill(0);
    dailyValues.forEach((value, index) => {
      weekTotals[Math.floor(index / 7)] += value;
    });
    display = dailyValues.map((_, index) => weekTotals[Math.floor(index / 7)]);
  } else if (mode === "cumulative") {
    let running = 0;
    display = dailyValues.map((value) => {
      running += value;
      return running;
    });
  }

  let max = 0;
  for (const value of display) max = Math.max(max, value);

  const cells = days.map((date, index) => {
    const value = display[index];
    return {
      day: dayKey(date),
      weekIndex: Math.floor(index / 7),
      weekdayIndex: (date.getDay() + 6) % 7,
      value,
      // Zero stays empty; anything above starts at level 1 so a single
      // token day is still visible.
      level: value <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((value / max) * 4))),
    };
  });

  // One label per month, pinned to the week its first day falls in.
  const monthLabels: { weekIndex: number; label: string }[] = [];
  let previousMonth = -1;
  for (let week = 0; week < weeks; week += 1) {
    const first = days[week * 7];
    if (!first) break;
    const month = first.getMonth();
    if (month !== previousMonth) {
      monthLabels.push({ weekIndex: week, label: `${month + 1}月` });
      previousMonth = month;
    }
  }

  return { cells, weeks, monthLabels };
}

/* ------------------------------------------------------------------------ */
/* Per-model trend series                                                    */
/* ------------------------------------------------------------------------ */

export interface TrendSeries {
  /** `null` = the "unknown model" bucket. */
  name: string | null;
  /** Palette index (stable across the donut and the trend legend). */
  colorIndex: number;
  /** Daily totals, aligned with `dayKeys`. */
  values: number[];
}

export interface ModelTrend {
  dayKeys: string[];
  series: TrendSeries[];
  /** Nice axis maximum over every series. */
  max: number;
}

/**
 * Zero-filled per-model daily series for the last `days` days (inclusive).
 * Every requested model gets a series — models with no data in the window
 * render as a flat line, which is exactly how the reference design treats
 * them.
 */
export function buildModelTrend(
  modelDaily: ModelDailyUsage[],
  modelNames: (string | null)[],
  days: number,
  today = new Date(),
): ModelTrend {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dayKeys: string[] = [];
  const indexByDay = new Map<string, number>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = dayKey(addDays(end, -offset));
    indexByDay.set(key, dayKeys.length);
    dayKeys.push(key);
  }

  const series: TrendSeries[] = modelNames.map((name, colorIndex) => ({
    name,
    colorIndex,
    values: new Array(dayKeys.length).fill(0),
  }));

  for (const row of modelDaily) {
    const index = indexByDay.get(row.day);
    if (index == null) continue;
    const target = series.find((s) => (s.name ?? null) === (row.modelName ?? null));
    if (!target) continue;
    target.values[index] += row.inputTokens + row.outputTokens;
  }

  let max = 0;
  for (const entry of series) {
    for (const value of entry.values) max = Math.max(max, value);
  }
  return { dayKeys, series, max: niceCeil(max) };
}

/**
 * Catmull-Rom smoothed path through the points.  Control points are clamped
 * to their segment's y-range so the curve never overshoots below the axis.
 */
export function smoothPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const round = (value: number) => Math.round(value * 10) / 10;
  if (points.length < 3) {
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"}${round(p.x)},${round(p.y)}`)
      .join(" ");
  }
  let d = `M${round(points[0].x)},${round(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] ?? p2;
    const clampY = (value: number) => Math.min(Math.max(value, Math.min(p1.y, p2.y)), Math.max(p1.y, p2.y));
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
    d += ` C${round(c1x)},${round(c1y)} ${round(c2x)},${round(c2y)} ${round(p2.x)},${round(p2.y)}`;
  }
  return d;
}

/* ------------------------------------------------------------------------ */
/* Donut                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * Palette for per-model colours.  Mid-tone hues chosen to stay legible on
 * both the light and the dark theme panels.
 */
export const MODEL_COLORS = [
  "#4C7DFF",
  "#35C08A",
  "#A855F7",
  "#F59E0B",
  "#EC4899",
  "#06B6D4",
  "#EF4444",
  "#84CC16",
];

export function modelColor(index: number): string {
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

export interface DonutSlice {
  /** SVG path for the ring segment. */
  d: string;
  /** Palette index of the slice's model. */
  colorIndex: number;
  value: number;
  percent: number;
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

/** Ring segment between two angles (degrees, 0 = 12 o'clock, clockwise). */
function arcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const outerStart = polar(cx, cy, outerRadius, startAngle);
  const outerEnd = polar(cx, cy, outerRadius, endAngle);
  const innerEnd = polar(cx, cy, innerRadius, endAngle);
  const innerStart = polar(cx, cy, innerRadius, startAngle);
  return [
    `M${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/**
 * Donut slices for the given values (same order → same palette indexes).
 * A single 100% slice is emitted as two half arcs, because one SVG arc
 * cannot sweep a full circle.
 */
export function buildDonut(values: number[], size = 168, thickness = 26): DonutSlice[] {
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return [];

  const cx = size / 2;
  const cy = size / 2;
  const outerRadius = size / 2 - 1;
  const innerRadius = Math.max(2, outerRadius - thickness);

  const slices: DonutSlice[] = [];
  let angle = 0;
  values.forEach((raw, colorIndex) => {
    const value = Math.max(0, raw);
    if (value <= 0) return;
    const sweep = (value / total) * 360;
    const start = angle;
    angle += sweep;
    if (sweep >= 359.999) {
      slices.push({
        d: arcPath(cx, cy, outerRadius, innerRadius, start, start + 180),
        colorIndex,
        value,
        percent: 100,
      });
      slices.push({
        d: arcPath(cx, cy, outerRadius, innerRadius, start + 180, start + 360),
        colorIndex,
        value,
        percent: 100,
      });
    } else {
      slices.push({
        d: arcPath(cx, cy, outerRadius, innerRadius, start, start + sweep),
        colorIndex,
        value,
        percent: (value / total) * 100,
      });
    }
  });
  return slices;
}
