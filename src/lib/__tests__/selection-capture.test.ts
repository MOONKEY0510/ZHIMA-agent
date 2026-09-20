import { describe, expect, it } from "vitest";
import { appendCapture, clampSelection, MAX_SELECTION_CHARS } from "../selection-capture";

describe("clampSelection", () => {
  it("keeps short selections intact", () => {
    expect(clampSelection("一段普通的选中文本")).toBe("一段普通的选中文本");
  });

  it("truncates over-long selections with an ellipsis", () => {
    const long = "字".repeat(MAX_SELECTION_CHARS + 500);
    const clamped = clampSelection(long);
    expect(clamped).toHaveLength(MAX_SELECTION_CHARS + 1);
    expect(clamped.endsWith("…")).toBe(true);
  });
});

describe("appendCapture", () => {
  it("fills an empty composer as-is", () => {
    expect(appendCapture("", "选中的文本")).toBe("选中的文本");
  });

  it("treats a whitespace-only composer as empty", () => {
    expect(appendCapture("\n\n  ", "选中的文本")).toBe("选中的文本");
  });

  it("appends after an existing draft, separated by a blank line", () => {
    expect(appendCapture("帮我翻译：", "Hello world")).toBe("帮我翻译：\n\nHello world");
  });

  it("does not stack blank lines on repeated captures", () => {
    const once = appendCapture("草稿", "第一段");
    const twice = appendCapture(once, "第二段");
    expect(twice).toBe("草稿\n\n第一段\n\n第二段");
  });
});
