import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { StreamingMarkdown, splitMarkdown } from "../StreamingMarkdown";

// The opener plugin talks to the Tauri shell; stub it out for DOM tests.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

describe("splitMarkdown", () => {
  it("keeps text without a blank line in the tail", () => {
    const result = splitMarkdown("第一段");
    expect(result.blocks).toEqual([]);
    expect(result.tail).toBe("第一段");
  });

  it("commits a block once a blank line follows it", () => {
    const result = splitMarkdown("第一段\n\n第二段");
    expect(result.blocks).toEqual(["第一段"]);
    expect(result.tail).toBe("第二段");
  });

  it("has no tail when the text ends on a blank line", () => {
    const result = splitMarkdown("第一段\n\n");
    expect(result.blocks).toEqual(["第一段"]);
    expect(result.tail).toBe("");
    expect(result.consumed).toBe("第一段\n\n".length);
  });

  it("keeps a closed code fence as a single block", () => {
    const result = splitMarkdown("```js\nconst x = 1;\n```\n\n");
    expect(result.blocks).toEqual(["```js\nconst x = 1;\n```"]);
    expect(result.tail).toBe("");
  });

  it("does not split on blank lines inside a fence", () => {
    const result = splitMarkdown("```\nlet a = 1;\n\nlet b = 2;\n```\n\n");
    expect(result.blocks).toEqual(["```\nlet a = 1;\n\nlet b = 2;\n```"]);
  });

  it("treats an unclosed fence as the tail", () => {
    const result = splitMarkdown("前言\n\n```js\nconst x = 1;");
    expect(result.blocks).toEqual(["前言"]);
    expect(result.tail).toBe("```js\nconst x = 1;");
  });

  it("reports the consumed prefix for incremental reuse", () => {
    expect(splitMarkdown("a\n\nb").consumed).toBe(3);
  });
});

describe("StreamingMarkdown", () => {
  it("renders finished blocks as Markdown and keeps the tail as plain text", () => {
    const { container } = render(
      <StreamingMarkdown content={"# 标题\n\n未完成 **加粗"} />,
    );
    expect(container.querySelector("h1")).toHaveTextContent("标题");
    // The tail is not parsed yet, so no <strong> should exist.
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("未完成 **加粗");
  });

  it("renders an unclosed code fence as a preformatted block", () => {
    const { container } = render(
      <StreamingMarkdown content={"```js\nconst x = 1;"} />,
    );
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.querySelector("code")).toHaveTextContent("const x = 1;");
  });

  it("shows the streaming caret", () => {
    const { container } = render(<StreamingMarkdown content={"你好"} caret />);
    expect(container.querySelector(".stream-caret")).not.toBeNull();
  });

  it("parses a block once it is closed on the next update", () => {
    const { container, rerender } = render(
      <StreamingMarkdown content={"一段文字"} />,
    );
    expect(container.querySelector("p")).toBeNull();

    rerender(<StreamingMarkdown content={"一段文字\n\n"} />);
    expect(container.querySelector("p")).toHaveTextContent("一段文字");
  });
});
