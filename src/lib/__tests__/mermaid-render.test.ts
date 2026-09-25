import { describe, expect, it } from "vitest";
import { wantsElk } from "../mermaid-render";

/**
 * ELK is ~1.4 MB, so it is fetched only for diagrams that plausibly need its
 * edge routing. The heuristic is intentionally crude — a wrong answer only
 * changes layout quality — but it must clearly separate small from large.
 */
describe("wantsElk", () => {
  it("keeps small diagrams on the built-in layout", () => {
    expect(wantsElk("flowchart TD\n  A[开始] --> B[结束]")).toBe(false);
    expect(
      wantsElk(["flowchart LR", "  A --> B", "  B --> C", "  C --> D"].join("\n")),
    ).toBe(false);
  });

  it("asks for ELK when a diagram has many nodes", () => {
    const nodes = Array.from({ length: 30 }, (_, i) => `  N${i}[节点 ${i}]`);
    expect(wantsElk(["flowchart TD", ...nodes].join("\n"))).toBe(true);
  });

  it("asks for ELK when a diagram is edge-heavy", () => {
    const edges = Array.from({ length: 20 }, (_, i) => `  A${i} --> B${i}`);
    expect(wantsElk(["flowchart LR", ...edges].join("\n"))).toBe(true);
  });

  it("ignores blank lines when counting", () => {
    const sparse = ["flowchart TD", "", "", "  A --> B", "", ""].join("\n");
    expect(wantsElk(sparse)).toBe(false);
  });
});
