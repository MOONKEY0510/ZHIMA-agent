import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

export interface MenuProps {
  /** The element that opens the menu — typically an IconButton or Pill. */
  trigger: ReactElement;
  children: ReactNode;
  /** Anchor side relative to the trigger. Composer menus open upward. */
  side?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Shared popover shell for every dropdown in the app (attachments, model
 * picker, theme picker, export menu, …). Handles outside-click, Esc-to-close
 * (without letting the keystroke bubble up and dismiss the whole floating
 * window — see App.tsx's capture-phase Escape listener) and consistent
 * positioning/visuals, so each call site only supplies the menu items.
 */
export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  className,
  open: controlledOpen,
  onOpenChange,
}: MenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const setOpen = (value: boolean) => {
    setUncontrolledOpen(value);
    onOpenChangeRef.current?.(value);
  };
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDocPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDocPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const triggerEl = isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(trigger)
    ? cloneElement(trigger, {
        onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
          trigger.props.onClick?.(e);
          setOpen(!open);
        },
        "aria-expanded": open,
      })
    : trigger;

  return (
    <div ref={ref} className="relative inline-block">
      {triggerEl}
      {open && (
        <div
          role="menu"
          className={[
            "absolute z-50 min-w-[10rem] overflow-hidden rounded-menu border border-line bg-panel p-1 shadow-menu",
            "cf-menu-pop",
            side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
            align === "end" ? "right-0" : "left-0",
            className ?? "",
          ].join(" ")}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  active?: boolean;
  danger?: boolean;
}

export function MenuItem({ icon, active, danger, className, children, ...rest }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={[
        "flex h-8 w-full items-center gap-2 rounded-btn px-2 text-left text-ui transition-colors duration-100",
        danger
          ? "text-danger hover:bg-[var(--cf-danger-weak)]"
          : active
            ? "bg-[color-mix(in_srgb,var(--cf-accent)_12%,transparent)] text-accent"
            : "text-ink hover:bg-hover",
        className ?? "",
      ].join(" ")}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-line" />;
}
