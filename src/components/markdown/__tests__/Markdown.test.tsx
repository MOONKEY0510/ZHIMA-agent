import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "../Markdown";

// The opener plugin talks to the Tauri shell; stub it out for DOM tests.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
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

  it("keeps inline code inline", () => {
    const { container } = render(<Markdown content={"使用 `npm install` 安装"} />);
    const inline = container.querySelector("code");
    expect(inline).not.toBeNull();
    expect(inline?.closest("pre")).toBeNull();
  });
});
