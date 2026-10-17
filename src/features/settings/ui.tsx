import { createPortal } from "react-dom";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "../../components/ui";

/** Fully custom dropdown. The browser-native `<select>` popup cannot be
 *  styled consistently across platforms, so we render our own menu.
 *  This gives the same rounded panel, border and hover states as the rest
 *  of the UI. */
export function Dropdown({
  value,
  onChange,
  options,
  disabled,
  title,
  className,
  placement = "bottom",
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  title?: string;
  className?: string;
  /** Open direction: `bottom` (default, dropdown) or `top` (pop-up above the
   *  trigger, useful when the control sits near the bottom of the window). */
  placement?: "bottom" | "top";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const menuCls =
    placement === "top"
      ? "cf-menu-pop absolute bottom-full right-0 z-50 mb-1 max-h-60 min-w-full overflow-y-auto rounded-menu border border-line bg-panel py-1 shadow-menu"
      : "cf-menu-pop absolute right-0 z-50 mt-1 max-h-60 min-w-full overflow-y-auto rounded-menu border border-line bg-panel py-1 shadow-menu";

  return (
    <div ref={ref} className={`relative ${className ?? ""}`} title={title}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center justify-end gap-1 rounded-btn border border-transparent bg-transparent px-1.5 py-1 text-right text-[0.9375rem] leading-5 text-ink outline-none transition-colors hover:bg-hover focus:border-accent disabled:opacity-40"
      >
        <span className="min-w-0 truncate">{selected?.label ?? value}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-ink-3 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className={menuCls}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-ui transition-colors ${
                option.value === value
                  ? "bg-accent/15 text-accent"
                  : "text-ink hover:bg-hover"
              }`}
            >
              <span>{option.label}</span>
              {option.value === value && (
                <span className="text-accent" aria-hidden="true">✓</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-3 flex items-center justify-between first:mt-0">
      <h2 className="text-ui font-semibold text-ink">{title}</h2>
      {action}
    </div>
  );
}

export function Notice({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p
      className={`rounded-btn border px-3 py-2 text-[0.8125rem] leading-5 ${
        ok
          ? "border-[color-mix(in_srgb,var(--cf-success)_35%,transparent)] bg-[color-mix(in_srgb,var(--cf-success)_6%,transparent)] text-success"
          : "border-[color-mix(in_srgb,var(--cf-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--cf-danger)_6%,transparent)] text-danger"
      }`}
    >
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------------ */
/* Modal used for adding / editing providers                                 */
/* ------------------------------------------------------------------------ */

const modalStack: HTMLElement[] = [];

export function Modal({
  title, subtitle, icon, actions, footer, size = "md", closeDisabled = false, onClose, children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "md" | "lg";
  closeDisabled?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  const disabledRef = useRef(closeDisabled);
  const subtitleId = useId();
  closeRef.current = onClose;
  disabledRef.current = closeDisabled;
  useLayoutEffect(() => {
    const panel = panelRef.current!;
    const previousFocus = returnFocusRef.current;
    modalStack.push(panel);
    // Keep an explicit field autofocus; otherwise focus the panel's first action.
    if (!panel.contains(document.activeElement)) {
      (panel.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)") ?? panel).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!disabledRef.current) closeRef.current();
      } else if (event.key === "Tab") {
        const nodes = Array.from(panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
        )).filter((node) => !node.hidden && !node.closest('[hidden]') &&
          (!node.closest("details:not([open])") || node.matches("details > summary")));
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (!first) { event.preventDefault(); panel.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      modalStack.splice(modalStack.indexOf(panel), 1);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm sm:p-4"
      onClick={() => { if (!closeDisabled) onClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title}
        aria-describedby={subtitle ? subtitleId : undefined} tabIndex={-1}
        className={`relative flex max-h-[calc(100dvh-2rem)] w-full min-w-0 flex-col overflow-hidden rounded-input border border-line bg-panel text-ui text-ink shadow-menu ${size === "lg" ? "max-w-2xl" : "max-w-lg"}`}
        onClick={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {icon && <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-btn bg-panel-2 text-accent" aria-hidden="true">{icon}</span>}
            <div className="min-w-0"><h2 className="text-ui font-semibold text-ink">{title}</h2>
              {subtitle && <p id={subtitleId} className="mt-0.5 text-meta text-ink-2">{subtitle}</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">{actions}
            <IconButton aria-label="关闭" title="关闭" icon={<X size={15} />} disabled={closeDisabled} onClick={onClose} />
          </div>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4">{children}</div>
        {footer && <footer className="shrink-0 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>, document.body,
  );
}

/* ------------------------------------------------------------------------ */
/* Shared settings UI primitives — used to reduce the "generated" look of   */
/* every page looking like a stack of identical pale cards.                 */
/* ------------------------------------------------------------------------ */

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
  ariaLabel,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section aria-label={ariaLabel} className={`cf-settings-section ${className ?? ""}`}>
      <div className="cf-settings-section-header">
        <div className="cf-settings-section-copy">
          <h2 className="cf-settings-section-title">{title}</h2>
          {description && <p className="cf-settings-section-desc">{description}</p>}
        </div>
        {action && <div className="cf-settings-section-actions">{action}</div>}
      </div>
      <div className="cf-settings-section-body">{children}</div>
    </section>
  );
}

export function FormRow({
  label,
  htmlFor,
  description,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`cf-form-row ${className ?? ""}`}>
      <div className="flex-1">
        <label
          htmlFor={htmlFor}
          className="block text-[0.9375rem] font-medium leading-5 text-ink"
        >
          {label}
        </label>
        {description && <p className="mt-1 text-[0.8125rem] leading-5 text-ink-2">{description}</p>}
      </div>
      <div className="flex min-w-0 max-w-[55%] shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function FormSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="cf-switch"
      title={label}
    >
      <span className="cf-switch-knob" />
    </button>
  );
}

/* Inline text button used for "edit / remove / test" actions inside
 * settings rows. Claude renders these as plain colored text, not as
 * bordered buttons, so the row stays quiet. */
export function InlineAction({
  onClick,
  tone = "accent",
  disabled,
  children,
  title,
}: {
  onClick: () => void;
  tone?: "accent" | "danger" | "neutral";
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  const toneCls =
    tone === "danger"
      ? "text-danger hover:opacity-80"
      : tone === "neutral"
        ? "text-ink-2 hover:text-ink"
        : "text-accent hover:opacity-80";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded px-1 py-0.5 text-[0.9375rem] leading-5 transition-opacity disabled:opacity-40 ${toneCls}`}
    >
      {children}
    </button>
  );
}

export function VisualPills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`cf-pill ${opt.value === value ? "is-active" : ""}`}
        >
          {opt.icon}
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
