import { describe, expect, it } from "vitest";
import { relativeTime } from "../time";

describe("relativeTime", () => {
  const now = Date.now();

  it("shows 刚刚 for the last minute", () => {
    expect(relativeTime(now - 10_000)).toBe("刚刚");
  });

  it("shows minutes within an hour", () => {
    expect(relativeTime(now - 5 * 60_000)).toBe("5 分钟前");
  });

  it("shows hours within a day", () => {
    expect(relativeTime(now - 3 * 3_600_000)).toBe("3 小时前");
  });

  it("shows 昨天 for the previous day", () => {
    expect(relativeTime(now - 30 * 3_600_000)).toBe("昨天");
  });

  it("shows days within a week", () => {
    expect(relativeTime(now - 3 * 86_400_000)).toBe("3 天前");
  });

  it("falls back to MM-DD for older timestamps in the same year", () => {
    const ts = new Date(new Date().getFullYear(), 0, 5).getTime();
    if (now - ts > 7 * 86_400_000) {
      expect(relativeTime(ts)).toBe("01-05");
    }
  });
});
