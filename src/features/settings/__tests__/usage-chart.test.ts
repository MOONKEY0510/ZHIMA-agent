import { describe, expect, it } from "vitest";
import type { DailyUsage, ModelDailyUsage } from "../../../services/usage-api";
import {
  axisLabelIndexes,
  buildDonut,
  buildHeatmap,
  buildModelTrend,
  computeStreaks,
  dayKey,
  formatCount,
  formatDayLabel,
  formatDuration,
  formatPercent,
  formatTokens,
  niceCeil,
  smoothPath,
} from "../usage-chart";

function day(dayKey: string, inputTokens: number, outputTokens: number, rounds = 1): DailyUsage {
  return { day: dayKey, inputTokens, outputTokens, rounds };
}

describe("formatTokens (万 / 亿 scale)", () => {
  it("keeps small numbers plain and switches to 万 / 亿", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(9999)).toBe("9999");
    expect(formatTokens(10_000)).toBe("1 万");
    expect(formatTokens(12_345)).toBe("1.2 万");
    expect(formatTokens(123_456)).toBe("12.3 万");
    expect(formatTokens(3_000_000)).toBe("300 万");
    expect(formatTokens(360_000_000)).toBe("3.6 亿");
  });

  it("never renders negative token counts", () => {
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("formatPercent / formatDuration / formatCount / formatDayLabel", () => {
  it("rounds large percentages and keeps one decimal when small", () => {
    expect(formatPercent(82.4)).toBe("82%");
    expect(formatPercent(2.16)).toBe("2.2%");
    expect(formatPercent(100)).toBe("100%");
  });

  it("renders hours / minutes / seconds", () => {
    expect(formatDuration(0)).toBe("0 秒");
    expect(formatDuration(45_000)).toBe("45 秒");
    expect(formatDuration(90_000)).toBe("1 分钟");
    expect(formatDuration(11_820_000)).toBe("3 小时 17 分");
    expect(formatDuration(7_200_000)).toBe("2 小时");
  });

  it("groups thousands and formats dates", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatDayLabel("2026-09-05")).toBe("9月5日");
  });
});

describe("niceCeil / axisLabelIndexes", () => {
  it("rounds axis maxima up to 1/2/5 x 10^n", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(150)).toBe(200);
    expect(niceCeil(7300)).toBe(10_000);
  });

  it("labels every point when few, and both ends when many", () => {
    expect(axisLabelIndexes(0)).toEqual([]);
    expect(axisLabelIndexes(3)).toEqual([0, 1, 2]);
    const indexes = axisLabelIndexes(30);
    expect(indexes[0]).toBe(0);
    expect(indexes[indexes.length - 1]).toBe(29);
    expect(indexes.length).toBeLessThanOrEqual(5);
  });
});

describe("computeStreaks", () => {
  const today = new Date(2026, 8, 20); // 2026-09-20

  it("counts the run ending today and the longest run", () => {
    const streaks = computeStreaks(["2026-09-18", "2026-09-19", "2026-09-20"], today);
    expect(streaks).toEqual({ current: 3, longest: 3 });
  });

  it("drops the current streak when today has no activity", () => {
    const streaks = computeStreaks(["2026-09-01", "2026-09-02", "2026-09-03"], today);
    expect(streaks.current).toBe(0);
    expect(streaks.longest).toBe(3);
  });

  it("tolerates duplicates, gaps and unsorted input", () => {
    const streaks = computeStreaks(
      ["2026-09-20", "2026-09-18", "2026-09-20", "2026-09-19", "2026-09-10"],
      today,
    );
    expect(streaks.current).toBe(3);
    expect(streaks.longest).toBe(3);
  });
});

describe("buildHeatmap", () => {
  const today = new Date(2026, 8, 20); // Sunday

  it("aligns the grid to whole weeks ending today", () => {
    const grid = buildHeatmap([], "daily", today);
    expect(grid.cells.length).toBe(371); // 53 whole weeks
    expect(grid.cells[0].day).toBe("2025-09-15"); // a Monday
    expect(grid.cells[0].weekdayIndex).toBe(0);
    expect(grid.cells[grid.cells.length - 1].day).toBe("2026-09-20");
    expect(grid.cells.every((cell) => cell.level === 0)).toBe(true);
  });

  it("scales levels relative to the busiest day and keeps gaps empty", () => {
    const grid = buildHeatmap([day("2026-09-20", 100, 50)], "daily", today);
    const last = grid.cells[grid.cells.length - 1];
    expect(last.value).toBe(150);
    expect(last.level).toBe(4);
    // The previous day has no data.
    expect(grid.cells[grid.cells.length - 2].value).toBe(0);
    expect(grid.cells[grid.cells.length - 2].level).toBe(0);
  });

  it("marks every day of a week with the same total in weekly mode", () => {
    // 2026-09-14 (Mon) … 2026-09-20 (Sun) is one week.
    const grid = buildHeatmap([day("2026-09-20", 100, 50)], "weekly", today);
    const week = grid.cells.filter((cell) => cell.weekIndex === grid.weeks - 1);
    expect(week).toHaveLength(7);
    expect(week.every((cell) => cell.value === 150)).toBe(true);
  });

  it("accumulates monotonically in cumulative mode", () => {
    const grid = buildHeatmap([day("2026-09-14", 10, 5), day("2026-09-20", 20, 5)], "cumulative", today);
    const values = grid.cells.map((cell) => cell.value);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
    expect(values[values.length - 1]).toBe(40);
  });

  it("emits one ascending month label per month", () => {
    const grid = buildHeatmap([], "daily", today);
    expect(grid.monthLabels.length).toBeGreaterThanOrEqual(12);
    expect(grid.monthLabels[0].label).toBe("9月");
    const indexes = grid.monthLabels.map((label) => label.weekIndex);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });
});

describe("buildModelTrend", () => {
  const today = new Date(2026, 8, 20);

  function row(modelName: string | null, day: string, input: number, output: number): ModelDailyUsage {
    return { modelName, day, inputTokens: input, outputTokens: output };
  }

  it("zero-fills a continuous window per model", () => {
    const trend = buildModelTrend(
      [
        row("alpha", "2026-09-20", 100, 50),
        row(null, "2026-09-19", 10, 5),
        row("alpha", "2026-08-01", 999, 999), // outside the window
        row("ghost", "2026-09-20", 5, 5), // not a tracked model
      ],
      ["alpha", null],
      7,
      today,
    );
    expect(trend.dayKeys).toHaveLength(7);
    expect(trend.dayKeys[0]).toBe("2026-09-14");
    expect(trend.series).toHaveLength(2);
    expect(trend.series[0].values[6]).toBe(150);
    expect(trend.series[0].values.slice(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(trend.series[1].values[5]).toBe(15);
    expect(trend.max).toBe(200); // niceCeil of 150
  });

  it("returns a flat zero series when nothing happened", () => {
    const trend = buildModelTrend([], ["alpha"], 7, today);
    expect(trend.series[0].values.every((value) => value === 0)).toBe(true);
    expect(trend.max).toBe(1);
  });
});

describe("buildDonut", () => {
  it("computes share percentages in input order", () => {
    const slices = buildDonut([50, 30, 20]);
    expect(slices).toHaveLength(3);
    expect(slices.map((slice) => Math.round(slice.percent))).toEqual([50, 30, 20]);
    expect(slices.map((slice) => slice.colorIndex)).toEqual([0, 1, 2]);
  });

  it("splits a single full-circle slice into two half arcs", () => {
    const slices = buildDonut([42]);
    expect(slices).toHaveLength(2);
    expect(slices.every((slice) => slice.percent === 100)).toBe(true);
  });

  it("skips empty models and handles the empty set", () => {
    expect(buildDonut([0, 0])).toEqual([]);
    expect(buildDonut([])).toEqual([]);
    expect(buildDonut([10, 0, 10])).toHaveLength(2);
  });
});

describe("smoothPath", () => {
  it("handles empty, short and long point lists", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe("M0,0 L10,10");
    const path = smoothPath([
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 20, y: 5 },
    ]);
    expect(path.startsWith("M0,0")).toBe(true);
    expect(path).toContain("C");
  });
});

describe("dayKey", () => {
  it("pads months and days", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
