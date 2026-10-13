import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "solid" | "subtle";

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: "h-6 w-6",
  md: "h-7 w-7",
  lg: "h-8 w-8",
};

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  // Default: transparent until hovered — the vast majority of toolbar
  // buttons across the app (composer, title bar, message actions).
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
  // Persistent emphasis, e.g. an active toggle or the send button.
  solid: "bg-accent text-accent-fg hover:opacity-90",
  // Slightly visible at rest without competing with real content.
  subtle: "bg-hover text-ink hover:bg-[color-mix(in_srgb,var(--cf-hover)_70%,var(--cf-text-2))]",
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  active?: boolean;
  "aria-label": string;
}

/**
 * The single icon-only button used across the title bar, composer toolbar
 * and message action rows. Centralising it means a size or hover tweak
 * lands everywhere at once instead of being hand-copied into N call sites.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    { icon, size = "md", variant = "ghost", active, className, disabled, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={[
          "inline-flex shrink-0 items-center justify-center rounded-btn transition-colors duration-150",
          SIZE_CLASSES[size],
          active ? VARIANT_CLASSES.solid : VARIANT_CLASSES[variant],
          disabled ? "cursor-not-allowed opacity-40" : "",
          className ?? "",
        ].join(" ")}
        {...rest}
      >
        {icon}
      </button>
    );
  },
);
