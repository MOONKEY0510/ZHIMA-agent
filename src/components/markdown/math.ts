/**
 * Lazy KaTeX support (P1-11.4).
 *
 * The KaTeX stylesheet + fonts weigh ~1 MB, and only a small share of
 * messages contain formulas, so the plugin code and the stylesheet are pulled
 * in as a separate chunk the first time a message actually looks like math.
 * Everything else renders without ever touching that chunk.
 */
import type { Pluggable, PluggableList } from "unified";

/**
 * Formula detection.  `$$ … $$` (display), `\( … \)` / `\[ … \]` and LaTeX
 * environments are unambiguous; for single `$…$` we require no whitespace just
 * inside the delimiters so prices like `$5 和 $6` are not mistaken for math.
 */
const MATH_PATTERN =
  /\$\$[\s\S]+?\$\$|\\\(|\\\[|\\begin\{(?:equation|align|aligned|array|cases|matrix|pmatrix|bmatrix|gather|split)\}|\$(?!\s)[^$\n]{1,200}?(?<!\s)\$/;

export function hasMathSyntax(content: string): boolean {
  return MATH_PATTERN.test(content);
}

export interface MathPlugins {
  remarkMath: Pluggable;
  /** Already a plugin *list*, options included. */
  rehypeKatex: PluggableList;
}

/**
 * remark-math only emits *display* math when the `$$` delimiters sit on their
 * own lines, while models routinely write `$$E=mc^2$$` on a single line.  A
 * standalone `$$…$$` line is therefore expanded to the multi-line form;
 * `$$` inside prose is left alone.
 */
export function normalizeDisplayMath(content: string): string {
  return content.replace(
    /^[ \t]*\$\$([^\n]+)\$\$[ \t]*$/gm,
    (_match: string, body: string) => `$$\n${body.trim()}\n$$`,
  );
}

let loaded: MathPlugins | null = null;
let pending: Promise<MathPlugins> | null = null;

/** Plugins that are ready right now (null until the chunk has loaded). */
export function mathPlugins(): MathPlugins | null {
  return loaded;
}

/** Load remark-math + rehype-katex (and their stylesheet) once. */
export function loadMathPlugins(): Promise<MathPlugins> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= (async () => {
    const [remark, rehype] = await Promise.all([
      import("remark-math"),
      import("rehype-katex"),
    ]);
    // Malformed LaTeX must not break the whole message: show it in red
    // instead of throwing.
    const plugins: MathPlugins = {
      remarkMath: remark.default as Pluggable,
      rehypeKatex: [
        [
          rehype.default,
          { throwOnError: false, errorColor: "var(--cf-danger)" },
        ] as Pluggable,
      ],
    };
    loaded = plugins;
    // The stylesheet is a separate chunk and best-effort: without it the
    // formulas still render, just with less precise spacing.
    void import("katex/dist/katex.min.css").catch((err: unknown) => {
      console.warn("KaTeX 样式加载失败（公式仍会渲染）:", err);
    });
    return plugins;
  })();
  return pending;
}
