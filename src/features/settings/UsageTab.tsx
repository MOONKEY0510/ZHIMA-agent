import { useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, RefreshCw } from "lucide-react";
import * as usageApi from "../../services/usage-api";
import type { UsageStats } from "../../services/usage-api";
import {
  axisLabelIndexes,
  buildDonut,
  buildHeatmap,
  buildModelTrend,
  computeStreaks,
  formatCount,
  formatDayLabel,
  formatDuration,
  formatPercent,
  formatTokens,
  modelColor,
  smoothPath,
  type Heatmap,
  type HeatmapCell,
  type HeatmapMode,
  type ModelTrend,
  type Streaks,
} from "./usage-chart";

/** Upper bound on trend lines — more than this turns the chart into spaghetti. */
const MAX_TREND_MODELS = 8;

/**
 * Usage tab: a zcode-style statistics dashboard built from local data only —
 * metric strip, a year-long activity heatmap, per-model trend lines and a
 * model-share donut.  Everything is hand-rolled SVG; the app ships without a
 * charting dependency on purpose.
 */
export function UsageTab() {
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("daily");
  const [rangeDays, setRangeDays] = useState<7 | 30>(7);

  const refresh = async () => {
    setLoading(true);
    try {
      setStats(await usageApi.getUsageStats());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const daily = stats?.daily ?? [];
  const modelDaily = stats?.modelDaily ?? [];
  const models = stats?.models ?? [];

  const trendModels = useMemo(() => models.slice(0, MAX_TREND_MODELS), [models]);
  const modelNames = useMemo(() => trendModels.map((model) => model.modelName), [trendModels]);

  const trend = useMemo(
    () => buildModelTrend(modelDaily, modelNames, rangeDays),
    [modelDaily, modelNames, rangeDays],
  );
  const heatmap = useMemo(() => buildHeatmap(daily, heatmapMode), [daily, heatmapMode]);
  const streaks = useMemo(
    () => computeStreaks(daily.filter((entry) => entry.rounds > 0).map((entry) => entry.day)),
    [daily],
  );
  const peak = useMemo(
    () => daily.reduce((max, entry) => Math.max(max, entry.inputTokens + entry.outputTokens), 0),
    [daily],
  );
  const donut = useMemo(() => {
    const values = models.map((model) => model.inputTokens + model.outputTokens);
    return { slices: buildDonut(values), total: values.reduce((sum, value) => sum + value, 0) };
  }, [models]);

  if (error) {
    return (
      <section className="cf-settings-section">
        <div className="cf-settings-section-body">
          <p className="px-4 py-6 text-xs leading-5 text-danger">{error}</p>
        </div>
      </section>
    );
  }

  if (!stats) {
    return (
      <section className="cf-settings-section">
        <div className="cf-settings-section-body">
          <p className="px-4 py-6 text-xs text-ink-2">加载中…</p>
        </div>
      </section>
    );
  }

  const hasRounds = stats.rounds > 0;
  const hasTokens = stats.roundsWithUsage > 0;

  return (
    <>
      <StatStrip stats={stats} peak={peak} streaks={streaks} />

      {!hasRounds ? (
        <section className="cf-settings-section">
          <div className="cf-settings-section-body">
            <EmptyState />
          </div>
        </section>
      ) : (
        <>
          {!hasTokens && (
            <section className="cf-settings-section">
              <div className="cf-settings-section-body">
                <p className="px-4 py-3 text-[11px] leading-5 text-ink-2">
                  已有 {formatCount(stats.rounds)} 轮对话，但都没有 token 记录：升级前的历史数据不会补记，
                  之后的对话会自动累计。
                </p>
              </div>
            </section>
          )}

          <ActivityHeatmap grid={heatmap} mode={heatmapMode} onModeChange={setHeatmapMode} />

          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="cf-settings-section-title">时间范围</h2>
            <Segmented
              value={rangeDays}
              options={[
                { value: 7 as const, label: "近 7 日" },
                { value: 30 as const, label: "近 30 日" },
              ]}
              onChange={setRangeDays}
            />
          </div>

          <section className="cf-settings-section">
            <div className="cf-settings-section-header">
              <div>
                <h2 className="cf-settings-section-title">每日 Token 趋势图</h2>
                <p className="cf-settings-section-desc">每个模型在所选区间内每天的 token 消耗。</p>
              </div>
            </div>
            <div className="cf-settings-section-body">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pt-3">
                {trendModels.map((model, index) => (
                  <span
                    key={`${model.modelName ?? "unknown"}-${index}`}
                    className="flex max-w-[140px] items-center gap-1.5 text-[10px] text-ink-2"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: modelColor(index) }}
                    />
                    <span className="truncate">{model.modelName ?? "未知模型"}</span>
                  </span>
                ))}
              </div>
              <TokenTrend trend={trend} />
            </div>
          </section>

          <ModelDonutCard models={models} slices={donut.slices} total={donut.total} />
        </>
      )}

      <div className="flex items-center justify-end pb-1">
        <button
          type="button"
          onClick={() => void refresh()}
          className="flex items-center gap-1.5 rounded-btn px-2.5 py-1.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------ */
/* Shared bits                                                               */
/* ------------------------------------------------------------------------ */

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex shrink-0 rounded-btn border border-line bg-panel-2 p-0.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-[6px] px-2 py-0.5 text-[11px] transition-colors ${
            option.value === value
              ? "bg-panel text-ink shadow-sm"
              : "text-ink-2 hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-8 text-center">
      <BarChart3 size={22} className="mx-auto text-ink-2" />
      <p className="mt-2 text-xs text-ink">暂无用量数据</p>
      <p className="mt-1 text-[11px] leading-5 text-ink-2">
        发一轮对话后，服务商返回的 token 用量会在这里累计；数据只保存在本机。
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Metric strip                                                              */
/* ------------------------------------------------------------------------ */

function StatStrip({
  stats,
  peak,
  streaks,
}: {
  stats: UsageStats;
  peak: number;
  streaks: Streaks;
}) {
  const items = [
    { label: "累计 Token 数", value: formatTokens(stats.inputTokens + stats.outputTokens) },
    { label: "峰值 Token 数", value: formatTokens(peak) },
    { label: "最长聊天时长", value: formatDuration(stats.longestSessionMs) },
    { label: "当前连续天数", value: `${streaks.current} 天` },
    { label: "最长连续天数", value: `${streaks.longest} 天` },
  ];
  return (
    <section className="cf-settings-section">
      <div className="cf-settings-section-body">
        <div className="grid grid-cols-5 divide-x divide-line">
          {items.map((item) => (
            <div key={item.label} className="min-w-0 px-1.5 py-3 text-center">
              <p className="truncate text-[13px] font-semibold tabular-nums text-ink" title={item.value}>
                {item.value}
              </p>
              <p className="mt-1 truncate text-[10px] text-ink-2">{item.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Activity heatmap                                                          */
/* ------------------------------------------------------------------------ */

const CELL = 8.2;
const CELL_GAP = 1.6;
const CELL_STEP = CELL + CELL_GAP;
const HEAT_LABEL_H = 14;
const LEVEL_OPACITY = [0, 0.22, 0.42, 0.68, 1];

const HEAT_MODE_OPTIONS: { value: HeatmapMode; label: string }[] = [
  { value: "daily", label: "每日" },
  { value: "weekly", label: "每周" },
  { value: "cumulative", label: "累计" },
];

const HEAT_MODE_CAPTION: Record<HeatmapMode, string> = {
  daily: "当日",
  weekly: "本周",
  cumulative: "累计到当日",
};

function ActivityHeatmap({
  grid,
  mode,
  onModeChange,
}: {
  grid: Heatmap;
  mode: HeatmapMode;
  onModeChange: (mode: HeatmapMode) => void;
}) {
  const [hover, setHover] = useState<HeatmapCell | null>(null);
  const width = grid.weeks * CELL_STEP;
  const height = 7 * CELL_STEP + HEAT_LABEL_H;

  return (
    <section className="cf-settings-section">
      <div className="cf-settings-section-header">
        <div>
          <h2 className="cf-settings-section-title">Token 活动</h2>
          <p className="cf-settings-section-desc">过去一年每天的 token 消耗强度。</p>
        </div>
        <Segmented value={mode} options={HEAT_MODE_OPTIONS} onChange={onModeChange} />
      </div>
      <div className="cf-settings-section-body">
        <div className="relative p-3">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="block w-full"
            style={{ aspectRatio: `${width} / ${height}` }}
            onMouseLeave={() => setHover(null)}
          >
            {grid.cells.map((cell) => (
              <rect
                key={cell.day}
                x={cell.weekIndex * CELL_STEP}
                y={cell.weekdayIndex * CELL_STEP}
                width={CELL}
                height={CELL}
                rx={2}
                fill={cell.level === 0 ? "var(--cf-panel-2)" : "var(--cf-accent)"}
                fillOpacity={cell.level === 0 ? 1 : LEVEL_OPACITY[cell.level]}
                onMouseEnter={() => setHover(cell)}
              />
            ))}
            {grid.monthLabels.map((label) => (
              <text
                key={`${label.weekIndex}-${label.label}`}
                x={label.weekIndex * CELL_STEP}
                y={height - 3}
                fontSize={8.5}
                fill="var(--cf-text-2)"
              >
                {label.label}
              </text>
            ))}
          </svg>

          {hover && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-btn border border-line bg-panel px-2 py-1 text-[10px] leading-4 text-ink shadow-lg"
              style={{
                left: `${(((hover.weekIndex * CELL_STEP + CELL / 2) / width) * 100).toFixed(2)}%`,
                top: `${(((hover.weekdayIndex * CELL_STEP + (hover.weekdayIndex < 2 ? CELL : 0)) / height) * 100).toFixed(2)}%`,
                transform:
                  hover.weekdayIndex < 2
                    ? "translate(-50%, 0)"
                    : "translate(-50%, -100%)",
                whiteSpace: "nowrap",
              }}
            >
              <span className="text-ink-2">{formatDayLabel(hover.day)}</span>
              {" · "}
              <span className="tabular-nums">
                {HEAT_MODE_CAPTION[mode]} {formatTokens(hover.value)}
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------ */
/* Per-model daily trend                                                     */
/* ------------------------------------------------------------------------ */

const TREND_W = 512;
const TREND_H = 170;
const TREND_LEFT = 6;
const TREND_RIGHT = 6;
const TREND_TOP = 12;
const TREND_BOTTOM = 22;
const TREND_INNER_W = TREND_W - TREND_LEFT - TREND_RIGHT;
const TREND_INNER_H = TREND_H - TREND_TOP - TREND_BOTTOM;

function TokenTrend({ trend }: { trend: ModelTrend }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const count = trend.dayKeys.length;
  const stepX = count > 1 ? TREND_INNER_W / (count - 1) : 0;
  const x = (index: number) =>
    count > 1 ? TREND_LEFT + index * stepX : TREND_LEFT + TREND_INNER_W / 2;
  const y = (value: number) => TREND_TOP + TREND_INNER_H - (value / trend.max) * TREND_INNER_H;

  const isEmpty = trend.series.every((series) => series.values.every((value) => value === 0));

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || count === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const viewX = ((event.clientX - rect.left) / rect.width) * TREND_W;
    const ratio = TREND_INNER_W > 0 ? (viewX - TREND_LEFT) / TREND_INNER_W : 0;
    const index = Math.round(ratio * (count - 1));
    setHoverIndex(Math.min(count - 1, Math.max(0, index)));
  };

  const active = hoverIndex != null ? hoverIndex : null;
  const tooltipRows =
    active != null
      ? trend.series
          .map((series) => ({ series, value: series.values[active] }))
          .filter((row) => row.value > 0)
          .sort((a, b) => b.value - a.value)
      : [];

  if (isEmpty) {
    return <p className="px-4 py-14 text-center text-xs text-ink-2">该时间段暂无 token 记录。</p>;
  }

  return (
    <div className="relative p-3 pb-1">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${TREND_W} ${TREND_H}`}
        className="block w-full"
        style={{ aspectRatio: `${TREND_W} / ${TREND_H}` }}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {[0, 1 / 3, 2 / 3, 1].map((fraction) => {
          const gy = TREND_TOP + TREND_INNER_H - fraction * TREND_INNER_H;
          return (
            <line
              key={fraction}
              x1={TREND_LEFT}
              y1={gy}
              x2={TREND_W - TREND_RIGHT}
              y2={gy}
              stroke="var(--cf-border)"
              strokeWidth={1}
              strokeDasharray={fraction === 0 ? undefined : "3 3"}
            />
          );
        })}

        {trend.series.map((series, index) => {
          const points = series.values.map((value, i) => ({ x: x(i), y: y(value) }));
          const flat = series.values.every((value) => value === 0);
          return (
            <path
              key={`${series.name ?? "unknown"}-${index}`}
              d={smoothPath(points)}
              fill="none"
              stroke={modelColor(series.colorIndex)}
              strokeWidth={flat ? 1.2 : 2}
              strokeOpacity={flat ? 0.35 : 1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}

        {axisLabelIndexes(count, count <= 10 ? count : 6).map((index) => (
          <text
            key={trend.dayKeys[index]}
            x={x(index)}
            y={TREND_H - 6}
            textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
            fontSize={9}
            fill="var(--cf-text-2)"
          >
            {formatDayLabel(trend.dayKeys[index])}
          </text>
        ))}

        {active != null && (
          <g>
            <line
              x1={x(active)}
              y1={TREND_TOP}
              x2={x(active)}
              y2={TREND_TOP + TREND_INNER_H}
              stroke="var(--cf-text-2)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            {trend.series
              .filter((series) => series.values[active] > 0)
              .map((series, index) => (
                <circle
                  key={`${series.name ?? "unknown"}-${index}`}
                  cx={x(active)}
                  cy={y(series.values[active])}
                  r={3}
                  fill={modelColor(series.colorIndex)}
                  stroke="var(--cf-panel)"
                  strokeWidth={1.5}
                />
              ))}
          </g>
        )}
      </svg>

      {active != null && tooltipRows.length > 0 && (
        <div
          className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-btn border border-line bg-panel px-2 py-1 text-[10px] leading-4 text-ink shadow-lg"
          style={{
            left: `${Math.min(92, Math.max(8, (x(active) / TREND_W) * 100)).toFixed(2)}%`,
            whiteSpace: "nowrap",
          }}
        >
          <div className="text-ink-2">{formatDayLabel(trend.dayKeys[active])}</div>
          {tooltipRows.map((row, index) => (
            <div key={`${row.series.name ?? "unknown"}-${index}`} className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: modelColor(row.series.colorIndex) }}
              />
              <span className="max-w-[130px] truncate">{row.series.name ?? "未知模型"}</span>
              <span className="ml-auto tabular-nums text-ink-2">{formatTokens(row.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Model share donut                                                         */
/* ------------------------------------------------------------------------ */

const DONUT_SIZE = 168;

function ModelDonutCard({
  models,
  slices,
  total,
}: {
  models: UsageStats["models"];
  slices: ReturnType<typeof buildDonut>;
  total: number;
}) {
  return (
    <section className="cf-settings-section">
      <div className="cf-settings-section-header">
        <div>
          <h2 className="cf-settings-section-title">模型用量</h2>
          <p className="cf-settings-section-desc">按累计 token 的占比分布。</p>
        </div>
      </div>
      <div className="cf-settings-section-body">
        {slices.length === 0 ? (
          <p className="px-4 py-6 text-xs text-ink-2">暂无模型用量。</p>
        ) : (
          <div className="flex items-center gap-4 p-3">
            <svg
              width={DONUT_SIZE}
              height={DONUT_SIZE}
              viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`}
              className="shrink-0"
            >
              {slices.map((slice, index) => (
                <path key={index} d={slice.d} fill={modelColor(slice.colorIndex)} />
              ))}
              <text
                x={DONUT_SIZE / 2}
                y={DONUT_SIZE / 2 - 3}
                textAnchor="middle"
                fontSize={15}
                fontWeight={600}
                fill="var(--cf-text)"
              >
                {formatTokens(total)}
              </text>
              <text
                x={DONUT_SIZE / 2}
                y={DONUT_SIZE / 2 + 12}
                textAnchor="middle"
                fontSize={9}
                fill="var(--cf-text-2)"
              >
                tokens
              </text>
            </svg>

            <ul className="min-w-0 flex-1 space-y-2.5">
              {models.map((model, index) => {
                const value = model.inputTokens + model.outputTokens;
                const percent = total > 0 ? (value / total) * 100 : 0;
                return (
                  <li
                    key={`${model.modelName ?? "unknown"}-${index}`}
                    className="flex items-start justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-[11px] text-ink">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: modelColor(index) }}
                        />
                        <span className="truncate">{model.modelName ?? "未知模型"}</span>
                      </p>
                      <p className="mt-0.5 pl-3.5 text-[10px] tabular-nums text-ink-2">
                        {formatTokens(value)} tokens
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-ink-2">
                      {formatPercent(percent)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
