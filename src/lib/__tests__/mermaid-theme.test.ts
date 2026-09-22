import { describe, expect, it } from "vitest";
import {
  DIAGRAM_STYLES,
  alpha,
  diagramSvgStyle,
  diagramTheme,
  isLightColor,
  mix,
  seriesPalette,
} from "../mermaid-theme";

describe("diagram colour helpers", () => {
  it("blends two hex colours", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("rgb(128, 128, 128)");
    expect(mix("#123456", "#123456", 1)).toBe("rgb(18, 52, 86)");
  });

  it("expands shorthand hex and applies alpha", () => {
    expect(alpha("#f00", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
  });

  it("falls back to the input for unparsable colours", () => {
    expect(mix("var(--x)", "#ffffff", 0.5)).toBe("var(--x)");
    expect(alpha("not-a-colour", 0.5)).toBe("not-a-colour");
  });

  it("detects light colours", () => {
    expect(isLightColor("#ffffff")).toBe(true);
    expect(isLightColor("#0d1424")).toBe(false);
  });

  it("builds a well-separated series palette", () => {
    const palette = seriesPalette("#639fd0", false);
    expect(palette).toHaveLength(8);
    expect(new Set(palette).size).toBe(8);
    for (const colour of palette) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("diagram themes", () => {
  it("offers the four documented styles", () => {
    expect(DIAGRAM_STYLES).toEqual(["auto", "tech", "morandi", "handdrawn"]);
  });

  it("provides a complete config for every style", () => {
    for (const style of DIAGRAM_STYLES) {
      const theme = diagramTheme(style, "light");
      expect(theme.canvas).toMatch(/^(#|rgb)/);
      expect(typeof theme.filter).toBe("string");

      const vars = theme.config.themeVariables as Record<string, string>;
      expect(vars.fontFamily).toContain("PingFang");
      expect(vars.primaryColor).toBeTruthy();
      expect(vars.lineColor).toBeTruthy();
      expect(vars.edgeLabelBackground).toBeTruthy();
      // pie1..pie12 / git0..git7 must all be filled for chart diagrams.
      for (let i = 1; i <= 12; i += 1) {
        expect(vars[`pie${i}`]).toBeTruthy();
      }
      for (let i = 0; i < 8; i += 1) {
        expect(vars[`git${i}`]).toBeTruthy();
      }
    }
  });

  it("applies the hand-drawn look without a shadow", () => {
    const theme = diagramTheme("handdrawn", "light");
    expect(theme.config.look).toBe("handDrawn");
    expect(theme.filter).toBe("none");
  });

  it("keeps the tech style on a dark canvas", () => {
    const theme = diagramTheme("tech", "light");
    expect(theme.canvas).toBe("#0d1424");
    const vars = theme.config.themeVariables as Record<string, string>;
    expect(vars.darkMode).toBe("true");
  });

  it("injects the drop-shadow into the svg stylesheet", () => {
    const style = diagramSvgStyle("drop-shadow(0 1px 2px #000)");
    expect(style).toContain("filter: drop-shadow(0 1px 2px #000)");
  });
});
