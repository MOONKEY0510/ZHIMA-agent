import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:opacity-90",
  secondary: "border border-line bg-panel text-ink hover:bg-hover",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink",
  danger: "border border-[color-mix(in_srgb,var(--cf-danger)_45%,var(--cf-border))] text-danger hover:bg-[var(--cf-danger-weak)]",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-ui",
  md: "h-8 px-3.5 text-ui",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Text/label buttons shared by settings forms, modals and approval cards. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={[
        "inline-flex items-center justify-center gap-1.5 rounded-btn font-medium transition-colors duration-150",
        SIZE_CLASSES[size],
        VARIANT_CLASSES[variant],
        disabled ? "cursor-not-allowed opacity-40" : "",
        className ?? "",
      ].join(" ")}
      {...rest}
    />
  );
});
