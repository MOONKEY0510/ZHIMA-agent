import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IconButton } from "../IconButton";
import { Button } from "../Button";
import { Pill } from "../Pill";
import { Menu, MenuItem } from "../Menu";
import { Tooltip } from "../Tooltip";

describe("IconButton", () => {
  it("renders the icon and responds to clicks", () => {
    const onClick = vi.fn();
    render(<IconButton icon={<span>★</span>} aria-label="收藏" onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "收藏" });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disables interaction when disabled", () => {
    const onClick = vi.fn();
    render(<IconButton icon={<span>★</span>} aria-label="收藏" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "收藏" }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Button", () => {
  it("renders children and variant classes", () => {
    render(<Button variant="primary">确定</Button>);
    expect(screen.getByRole("button", { name: "确定" })).toHaveClass("bg-accent");
  });
});

describe("Pill", () => {
  it("collapses the label when compact", () => {
    render(
      <Pill compact aria-label="深度思考">
        深度思考
      </Pill>,
    );
    expect(screen.queryByText("深度思考")).toBeNull();
  });

  it("shows the label when not compact", () => {
    render(<Pill>深度思考</Pill>);
    expect(screen.getByText("深度思考")).toBeInTheDocument();
  });
});

describe("Menu", () => {
  it("opens on trigger click and closes on outside click", () => {
    render(
      <Menu trigger={<button type="button">打开</button>}>
        <MenuItem>选项一</MenuItem>
      </Menu>,
    );
    expect(screen.queryByText("选项一")).toBeNull();
    fireEvent.click(screen.getByText("打开"));
    expect(screen.getByText("选项一")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("选项一")).toBeNull();
  });

  it("closes on Escape and prevents the keystroke from bubbling further", () => {
    render(
      <Menu trigger={<button type="button">打开</button>}>
        <MenuItem>选项一</MenuItem>
      </Menu>,
    );
    fireEvent.click(screen.getByText("打开"));
    expect(screen.getByText("选项一")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("选项一")).toBeNull();
  });
});

describe("Tooltip", () => {
  it("renders its child without the tooltip bubble by default", () => {
    render(
      <Tooltip label="复制">
        <button type="button">按钮</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "按钮" })).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
