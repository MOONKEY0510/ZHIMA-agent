import {
  BookOpen,
  Bot,
  Briefcase,
  ClipboardList,
  Code,
  GraduationCap,
  Languages,
  Lightbulb,
  MessageCircle,
  PenLine,
  Search,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

/**
 * Vector icon set for assistants — a line-icon style that matches the rest of
 * the UI (the app bundles lucide icons rather than emoji so they follow the
 * theme colour and stay crisp at any size).
 *
 * Built-in assistants store one of these keys in their `icon` column; the
 * editor offers the same list.  Anything that is not a key (legacy emoji from
 * older versions, or a user-typed character) still renders as plain text, so
 * nothing breaks for existing data.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  search: Search,
  "pen-line": PenLine,
  code: Code,
  languages: Languages,
  "clipboard-list": ClipboardList,
  "message-circle": MessageCircle,
  "book-open": BookOpen,
  lightbulb: Lightbulb,
  briefcase: Briefcase,
  "graduation-cap": GraduationCap,
  bot: Bot,
};

/** Keys offered by the assistant editor, in display order. */
export const ASSISTANT_ICON_KEYS = Object.keys(ICON_MAP);

/** Tooltip label for each key in the picker. */
export const ASSISTANT_ICON_LABELS: Record<string, string> = {
  sparkles: "通用 / 灵感",
  search: "检索",
  "pen-line": "写作",
  code: "编程",
  languages: "翻译",
  "clipboard-list": "记录",
  "message-circle": "对话",
  "book-open": "资料",
  lightbulb: "创意",
  briefcase: "工作",
  "graduation-cap": "学习",
  bot: "机器人",
};

/** Whether the stored value is one of the vector keys. */
export function isAssistantIconKey(icon: string | null | undefined): boolean {
  return !!icon && icon in ICON_MAP;
}

/**
 * Render an assistant's icon: a vector key becomes an SVG in the current text
 * colour, a custom string (emoji etc.) is shown as-is, and an empty value
 * falls back to the bot glyph.
 */
export function AssistantIcon({
  icon,
  size = 14,
  className,
}: {
  icon?: string | null;
  size?: number;
  className?: string;
}) {
  if (icon && ICON_MAP[icon]) {
    const Icon = ICON_MAP[icon];
    return <Icon size={size} className={className} aria-hidden="true" />;
  }
  if (icon && icon.trim()) {
    return (
      <span
        aria-hidden="true"
        className={className}
        style={{ fontSize: size + 1, lineHeight: 1 }}
      >
        {icon}
      </span>
    );
  }
  return <Bot size={size} className={className} aria-hidden="true" />;
}
