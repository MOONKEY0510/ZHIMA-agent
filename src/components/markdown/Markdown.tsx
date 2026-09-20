import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ChevronDown, Copy } from "lucide-react";
import type { PluggableList } from "unified";
import {
  hasMathSyntax,
  loadMathPlugins,
  mathPlugins,
  normalizeDisplayMath,
  type MathPlugins,
} from "./math";

/**
 * Markdown rendering with GFM tables, syntax highlighting and safe links.
 *
 * Raw HTML is never rendered (no rehype-raw), which blocks XSS through
 * message content (plan §6). External links are validated and handed to the
 * system browser instead of the webview. Highlighting uses lowlight's common
 * language bundle; unknown languages fall back to plain code.
 *
 * Formulas (P1-11.4) are handled by KaTeX, loaded lazily: the plugins and
 * their ~1 MB stylesheet only join the render once a message looks like math.
 */
export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const math = useMathSupport(content);

  const remarkPlugins: PluggableList = math ? [remarkGfm, math.remarkMath] : [remarkGfm];
  const rehypePlugins: PluggableList = math
    ? [[rehypeHighlight, { detect: false }], ...math.rehypeKatex]
    : [[rehypeHighlight, { detect: false }]];

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{
        pre(props) {
          return <PreBlock>{props.children}</PreBlock>;
        },
        a(props) {
          return <SafeLink href={props.href}>{props.children}</SafeLink>;
        },
      }}
    >
      {math ? normalizeDisplayMath(content) : content}
    </ReactMarkdown>
  );
});

/** Load the math chunk on demand and re-render once it is available. */
function useMathSupport(content: string): MathPlugins | null {
  const needed = hasMathSyntax(content);
  const [plugins, setPlugins] = useState<MathPlugins | null>(() => mathPlugins());

  useEffect(() => {
    if (!needed || plugins) return;
    let cancelled = false;
    void loadMathPlugins().then((value) => {
      if (!cancelled) setPlugins(value);
    });
    return () => {
      cancelled = true;
    };
  }, [needed, plugins]);

  return plugins;
}

/** Find a `language-xxx` class anywhere inside the rendered code element. */
function extractLanguage(node: ReactNode): string {
  let lang = "";
  const walk = (n: ReactNode): void => {
    if (lang || !isValidElement(n)) return;
    const el = n as ReactElement<{ className?: string; children?: ReactNode }>;
    const match = el.props.className
      ? /language-([\w+-]+)/.exec(el.props.className)
      : null;
    if (match) {
      lang = match[1];
      return;
    }
    Children.forEach(el.props.children, walk);
  };
  walk(node);
  return lang;
}

/** Threshold: code blocks with this many lines are collapsed by default. */
const COLLAPSE_THRESHOLD = 20;

function PreBlock({ children }: { children?: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const language = extractLanguage(children);

  // Count lines in the rendered code to decide whether to offer collapse.
  const lineCount = countCodeLines(children);
  const canCollapse = lineCount > COLLAPSE_THRESHOLD;

  const copy = async () => {
    const text = scrollRef.current?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Ignore clipboard failures.
    }
  };

  return (
    <pre>
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-ink-2">
          {language || "code"}
          {canCollapse && (
            <span className="ml-1.5 text-ink-2/60">· {lineCount} 行</span>
          )}
        </span>
        <div className="flex items-center gap-0.5">
          {canCollapse && (
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
            >
              <ChevronDown
                size={11}
                className={`transition-transform ${collapsed ? "" : "rotate-180"}`}
              />
              {collapsed ? "展开" : "折叠"}
            </button>
          )}
          <button
            onClick={() => void copy()}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
          >
            {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="code-scroll"
        style={
          canCollapse && collapsed
            ? { maxHeight: `${COLLAPSE_THRESHOLD * 1.5}rem`, overflow: "hidden" }
            : undefined
        }
      >
        {children}
      </div>
      {canCollapse && collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          className="w-full border-t border-line py-1 text-center text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
        >
          展开剩余 {lineCount - COLLAPSE_THRESHOLD} 行
        </button>
      )}
    </pre>
  );
}

/** Count the number of lines inside the rendered code element. */
function countCodeLines(node: ReactNode): number {
  const text = extractCodeText(node);
  if (!text) return 0;
  return text.split("\n").length;
}

/** Extract the raw text content from the code element tree. */
function extractCodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractCodeText).join("");
  if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    return extractCodeText(el.props.children);
  }
  return "";
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  const open = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (!href) return;
    // Only hand http(s) URLs to the system browser (plan §6.8).
    if (!/^https?:\/\//i.test(href)) return;
    void openUrl(href).catch(() => undefined);
  };
  return (
    <a href={href} onClick={open} title={href}>
      {children}
    </a>
  );
}
