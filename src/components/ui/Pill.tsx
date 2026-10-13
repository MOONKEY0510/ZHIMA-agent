import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface PillProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  active?: boolean;
  /** Collapses the label (icon-only) — used in the compact floating window. */
  compact?: boolean;
}

/**
 * The toggle-style pill used for composer options (深度思考, 联网搜索, …).
 * `active` switches it from a neutral outline to a tinted accent state.
 */
export function Pill({ icon, active, compact, className, children, ...rest }: PillProps) {
  return (
    <button
      type="button"
      className={[
        "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-ui transition-colors duration-150",
        active
          ? "border-[color-mix(in_srgb,var(--cf-accent)_45%,var(--cf-border))] bg-[color-mix(in_srgb,var(--cf-accent)_10%,transparent)] text-accent"
          : "border-line text-ink-2 hover:bg-hover hover:text-ink",
        className ?? "",
      ].join(" ")}
      {...rest}
    >
      {icon}
      {!compact && children}
    </button>
  );
}
