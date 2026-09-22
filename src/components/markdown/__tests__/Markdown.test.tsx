import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Markdown } from "../Markdown";
import { hasMathSyntax, normalizeDisplayMath } from "../math";

// The opener plugin talks to the Tauri shell; stub it out for DOM tests.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

// Diagram rendering pulls in the ~1 MB mermaid chunk and needs a real layout
// engine; the Markdown integration only verifies wiring, so stub it out.
vi.mock("../../../lib/mermaid-render", () => ({
  renderMermaidDiagram: vi.fn(async () => '<svg id="mock-diagram"><g/></svg>'),
}));

describe("Markdown", () => {
  it("renders basic markdown elements", () => {
    const { container } = render(<Markdown content={"# 标题\n\n一段 **加粗** 文本"} />);
    expect(container.querySelector("h1")).toHaveTextContent("标题");
    expect(container.querySelector("strong")).toHaveTextContent("加粗");
  });

  it("renders GFM tables", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const { container } = render(<Markdown content={md} />);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("td").length).toBe(2);
  });

  it("renders fenced code blocks with a copy header and highlighting", () => {
    const md = "```js\nconst x = 1;\n```";
    const { container } = render(<Markdown content={md} />);

    // Copy header shows the language label.
    expect(screen.getByText("js")).toBeInTheDocument();
    expect(screen.getByText("复制")).toBeInTheDocument();

    // lowlight produces highlight spans.
    expect(container.querySelector(".hljs")).not.toBeNull();
    expect(container.querySelector(".code-scroll code")).toHaveTextContent(
      "const x = 1;",
    );
  });

  it("never renders raw HTML from message content (XSS guard)", () => {
    const { container } = render(
      <Markdown content={'正常文本<img src=x onerror="alert(1)"><script>alert(2)</script>'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("正常文本");
  });

  it("detects formula syntax without flagging prices", () => {
    expect(hasMathSyntax("行内 $E=mc^2$")).toBe(true);
    expect(hasMathSyntax("块级\n\n$$\\int_0^1 x\\,dx$$")).toBe(true);
    expect(hasMathSyntax("\\begin{equation}x=1\\end{equation}")).toBe(true);
    expect(hasMathSyntax("这段文字里 \\(a+b\\) 是公式")).toBe(true);
    // Prices and currency amounts must not trigger the math chunk.
    expect(hasMathSyntax("价格是 $5 到 $6，共 $11")).toBe(false);
    expect(hasMathSyntax("普通文本，没有任何公式")).toBe(false);
  });

  it("expands a standalone $$…$$ line so it renders as display math", () => {
    expect(normalizeDisplayMath("$$E=mc^2$$")).toBe("$$\nE=mc^2\n$$");
    // Inline occurrences stay untouched.
    expect(normalizeDisplayMath("文字 $$x$$ 文字")).toBe("文字 $$x$$ 文字");
  });

  it("renders inline and display formulas via katex", async () => {
    const { container } = render(
      <Markdown content={"行内 $E=mc^2$ 与块级公式：\n\n$$\\int_0^1 x\\,dx$$"} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".katex")).not.toBeNull();
    });
    // The display formula gets its own block wrapper.
    expect(container.querySelector(".katex-display")).not.toBeNull();
    // Raw TeX markers are consumed by the renderer.
    expect(container.textContent).not.toContain("$$");
  });

  it("keeps inline code inline", () => {
    const { container } = render(<Markdown content={"使用 `npm install` 安装"} />);
    const inline = container.querySelector("code");
    expect(inline).not.toBeNull();
    expect(inline?.closest("pre")).toBeNull();
  });

  it("renders mermaid code blocks as diagrams instead of code", async () => {
    const md = "```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```";
    const { container } = render(<Markdown content={md} />);

    // The diagram card appears once the (mocked) render resolves.
    expect(await screen.findByText("mermaid 图表")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector(".cf-diagram-svg #mock-diagram")).not.toBeNull();
    });
    // The raw source is not shown as a code block.
    expect(container.querySelector("pre")).toBeNull();
  });
});
