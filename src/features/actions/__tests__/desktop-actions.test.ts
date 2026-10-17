import { describe, expect, it } from "vitest";
import { appendActionTemplate, desktopPresets, sanitizePresets } from "../desktop-actions";

const legacy = { id: "old", name: "旧指令", command: "/old", content: "旧正文" };
const action = { id: "action", name: "动作", command: "/action", content: "兼容正文", desktopAction: { source: "clipboard" as const, template: "处理 {{input}} / {{input}}", skillIds: ["s1"], output: "copy" as const } };

describe("desktop action contracts", () => {
  it("keeps legacy slash commands and validates optional action metadata", () => {
    expect(sanitizePresets([legacy, action])).toEqual([legacy, action]);
    expect(sanitizePresets([{ ...legacy, desktopAction: { source: "invalid" } }])).toEqual([legacy]);
    expect(sanitizePresets([null, { id: "bad" }])).toEqual([]);
  });
  it("appends templates without discarding drafts or interpreting replacement strings", () => {
    expect(appendActionTemplate("draft\n", action.desktopAction, "$& text")).toBe("draft\n\n\n处理 $& text / $& text");
    expect(appendActionTemplate("draft", { ...action.desktopAction, template: "No placeholder" }, "input")).toBe("draft\n\nNo placeholder\n\ninput");
  });
  it("filters legacy presets and puts favorites first without mutating persisted order", () => {
    const favorite = { ...action, id: "favorite", desktopAction: { ...action.desktopAction, favorite: true } };
    const presets = [legacy, action, favorite];
    expect(desktopPresets(presets).map((p) => p.id)).toEqual(["favorite", "action"]);
    expect(presets[1].id).toBe("action");
  });
  it("strips unknown nested fields from non-sensitive preset exports", () => {
    const clean = sanitizePresets([{ ...action, secret: "not exported", desktopAction: { ...action.desktopAction, token: "not exported" } }]);
    expect(JSON.stringify(clean)).not.toContain("not exported");
  });
});
