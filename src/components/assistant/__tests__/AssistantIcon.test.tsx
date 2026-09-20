import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ASSISTANT_ICON_KEYS, AssistantIcon, isAssistantIconKey } from "../AssistantIcon";

describe("AssistantIcon", () => {
  it("renders a vector icon for a known key", () => {
    const { container } = render(<AssistantIcon icon="search" />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toBe("");
  });

  it("keeps legacy emoji (and other custom values) as text", () => {
    const { container } = render(<AssistantIcon icon="🔍" />);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toBe("🔍");
  });

  it("falls back to the bot glyph when no icon is set", () => {
    const { container } = render(<AssistantIcon icon={null} />);
    expect(container.querySelector("svg")).toBeTruthy();
    const { container: blank } = render(<AssistantIcon icon="  " />);
    expect(blank.querySelector("svg")).toBeTruthy();
  });
});

describe("assistant icon keys", () => {
  it("covers the shipped built-in assistants", () => {
    // Keep in sync with `BUILTINS` in src-tauri/src/storage/assistants.rs.
    for (const key of ["sparkles", "languages", "pen-line", "code", "book-open", "search"]) {
      expect(ASSISTANT_ICON_KEYS).toContain(key);
    }
  });

  it("recognises keys and rejects anything else", () => {
    expect(isAssistantIconKey("code")).toBe(true);
    expect(isAssistantIconKey("🔍")).toBe(false);
    expect(isAssistantIconKey(null)).toBe(false);
  });
});
