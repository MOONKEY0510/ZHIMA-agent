import { describe, expect, it } from "vitest";
import { formatTriggers, newSkill, parseTriggers } from "../skills-api";

describe("skills api helpers", () => {
  it("splits trigger input on common separators", () => {
    expect(parseTriggers("周报，weekly; 汇报、日报")).toEqual([
      "周报",
      "weekly",
      "汇报",
      "日报",
    ]);
    expect(parseTriggers("   ")).toEqual([]);
    expect(parseTriggers("")).toEqual([]);
  });

  it("formats triggers back into an editable line", () => {
    expect(formatTriggers(["周报", "weekly"])).toBe("周报，weekly");
    expect(formatTriggers([])).toBe("");
  });

  it("round-trips through format + parse", () => {
    const triggers = ["代码审查", "code review"];
    expect(parseTriggers(formatTriggers(triggers))).toEqual(triggers);
  });

  it("new skill drafts start enabled with an empty id", () => {
    const draft = newSkill();
    expect(draft.id).toBe("");
    expect(draft.enabled).toBe(true);
    expect(draft.triggers).toEqual([]);
    expect(draft.name).toBe("");
  });
});
