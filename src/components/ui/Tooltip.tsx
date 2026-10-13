import { cloneElement, isValidElement, useId, useRef, useState } from "react";
import type { ReactElement } from "react";

export interface TooltipProps {
  label: string;
  children: ReactElement;
  side?: "top" | "bottom";
}

/**
 * Minimal hover/focus tooltip. Replaces the browser's native `title`
 * attribute (slow to appear, unstyled) for icon-only buttons across the
 * toolbar, title bar and message actions.
 */
export function Tooltip({ label, children, side = "top" }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | null>(null);
  const id = useId();

  const show = () => {
    timer.current = window.setTimeout(() => setVisible(true), 350);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    setVisible(false);
  };

  const child = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        "aria-describedby": visible ? id : undefined,
        onMouseEnter: (e: React.MouseEvent) => {
          (children.props as { onMouseEnter?: (e: React.MouseEvent) => void }).onMouseEnter?.(e);
          show();
        },
        onMouseLeave: (e: React.MouseEvent) => {
          (children.props as { onMouseLeave?: (e: React.MouseEvent) => void }).onMouseLeave?.(e);
          hide();
        },
        onFocus: (e: React.FocusEvent) => {
          (children.props as { onFocus?: (e: React.FocusEvent) => void }).onFocus?.(e);
          show();
        },
        onBlur: (e: React.FocusEvent) => {
          (children.props as { onBlur?: (e: React.FocusEvent) => void }).onBlur?.(e);
          hide();
        },
      })
    : children;

  return (
    <span className="relative inline-flex">
      {child}
      {visible && (
        <span
          id={id}
          role="tooltip"
          className={[
            "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-btn bg-[var(--cf-text)] px-2 py-1 text-meta text-[var(--cf-bg)] shadow-menu",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          ].join(" ")}
        >
          {label}
        </span>
      )}
    </span>
  );
}
