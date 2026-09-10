import { memo, useMemo, useRef } from "react";
import { Markdown } from "./Markdown";

/**
 * Result of splitting streamed Markdown into renderable pieces.
 *
 * `blocks` are finished, self-contained chunks that can be handed to the
 * Markdown parser right away. `tail` is the still-growing remainder (which may
 * contain an unclosed code fence); it is rendered as plain text so half-written
 * syntax does not make the layout jump around. `consumed` is the length of the
 * prefix that produced `blocks`, letting the next update reuse the work.
 */
export interface MarkdownSplit {
  blocks: string[];
  tail: string;
  consumed: number;
}

/**
 * Split streamed Markdown into finished blocks and an unfinished tail.
 *
 * A block ends at a blank line or a closing code fence. Blank lines inside a
 * fence are preserved, so a code block is never cut in half while it streams.
 */
export function splitMarkdown(text: string): MarkdownSplit {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let consumed = 0;

  const flush = (end: number) => {
    if (current.length === 0) return;
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
    consumed = end;
  };

  let lineStart = 0;
  while (lineStart < text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const hasNewline = newlineIndex !== -1;
    const lineEnd = hasNewline ? newlineIndex : text.length;
    const line = text.slice(lineStart, lineEnd);
    const nextLineStart = hasNewline ? lineEnd + 1 : lineEnd;

    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const char = fence[1].charAt(0);
      if (!inFence) {
        // A fence starts a fresh block; anything buffered before it is done.
        flush(lineStart);
        inFence = true;
        fenceChar = char;
        current.push(line);
      } else if (char === fenceChar) {
        current.push(line);
        inFence = false;
        flush(nextLineStart);
      } else {
        current.push(line);
      }
    } else if (!inFence && line.trim() === "") {
      flush(nextLineStart);
    } else {
      current.push(line);
    }

    if (!hasNewline) break;
    lineStart = nextLineStart;
  }

  const tail = current.join("\n").replace(/^\n+/, "").trimEnd();
  return {
    blocks,
    tail,
    consumed: tail ? consumed : text.length,
  };
}

interface SplitCache {
  /** Prefix of the streamed text that has already produced `blocks`. */
  consumed: string;
  blocks: string[];
}

/**
 * Renders a growing Markdown string incrementally.
 *
 * Finished blocks are parsed by {@link Markdown} (which is memoized, so blocks
 * that did not change are not re-parsed); the unfinished tail stays plain text.
 * This keeps the answer readable while it streams without the layout jumping
 * over half-written tables or code fences.
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  content,
  caret = false,
}: {
  content: string;
  caret?: boolean;
}) {
  const cacheRef = useRef<SplitCache>({ consumed: "", blocks: [] });

  const { blocks, tail } = useMemo(() => {
    const cache = cacheRef.current;
    // Streamed text only ever grows, so the already-split prefix can be reused
    // and only the newly appended characters need to be scanned.
    if (cache.consumed.length > 0 && content.startsWith(cache.consumed)) {
      const rest = content.slice(cache.consumed.length);
      const split = splitMarkdown(rest);
      const merged = [...cache.blocks, ...split.blocks];
      cacheRef.current = {
        consumed: cache.consumed + rest.slice(0, split.consumed),
        blocks: merged,
      };
      return { blocks: merged, tail: split.tail };
    }

    const split = splitMarkdown(content);
    cacheRef.current = {
      consumed: content.slice(0, split.consumed),
      blocks: split.blocks,
    };
    return { blocks: split.blocks, tail: split.tail };
  }, [content]);

  return (
    <>
      {blocks.map((block, index) => (
        <Markdown key={index} content={block} />
      ))}
      {tail ? (
        <StreamingTail text={tail} caret={caret} />
      ) : (
        caret && <span className="stream-caret" />
      )}
    </>
  );
});

/**
 * The unfinished tail. An unclosed code fence keeps its monospace layout so the
 * text does not reflow when the fence finally closes; everything else is plain
 * pre-wrapped text.
 */
function StreamingTail({ text, caret }: { text: string; caret: boolean }) {
  const fence = /^ {0,3}(?:`{3,}|~{3,})([^\n]*)\n?([\s\S]*)$/.exec(text);
  if (fence) {
    const language = fence[1].trim();
    return (
      <pre>
        <div className="flex items-center border-b border-line px-3 py-1.5">
          <span className="text-[11px] uppercase tracking-wide text-ink-2">
            {language || "code"}
          </span>
        </div>
        <div className="code-scroll">
          <code>{fence[2]}</code>
          {caret && <span className="stream-caret" />}
        </div>
      </pre>
    );
  }

  return (
    <span className="whitespace-pre-wrap break-words">
      {text}
      {caret && <span className="stream-caret" />}
    </span>
  );
}
