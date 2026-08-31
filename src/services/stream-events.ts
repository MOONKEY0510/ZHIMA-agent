import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChatStreamEvent } from "../types";
import { useChatStore } from "../stores/chat-store";

/**
 * Bridges Rust `chat-event` emissions into the chat store.
 *
 * High-frequency token deltas are batched in a buffer and flushed once per
 * animation frame (plan §5.3), so a burst of single-character deltas causes
 * a single re-render instead of one per token.
 *
 * Each event carries a `seq` field (monotonic per run).  The buffer tracks
 * the last seen sequence per requestId and logs gaps to the console so
 * dropped events are visible during development.
 */
export class DeltaBuffer {
  private pending = new Map<string, string>();
  private pendingReasoning = new Map<string, string>();
  /**
   * Finish events waiting for their buffered deltas to be rendered.
   *
   * A `finish` is held back until the per-frame throttled renderer has
   * drained everything for that run. Without this, an endpoint that returns
   * the whole answer in one burst (e.g. a buffering relay) would flush the
   * entire text in a single frame — the "renders only after the reply is
   * complete" feel. Deferring the finish keeps the increment visible.
   */
  private pendingFinish = new Map<string, string | undefined>();
  private scheduled = false;
  /** Next sequence expected for each request. */
  private nextSeq = new Map<string, number>();
  /** Events that arrived ahead of a missing lower sequence. */
  private queuedEvents = new Map<string, Map<number, ChatStreamEvent>>();
  /**
   * Maximum characters applied to the UI per animation frame, per request.
   *
   * Real streaming endpoints deliver a handful of chars per event, so they
   * are unaffected (the buffer is already drained each frame). A burst —
   * either a whole response arriving at once or a backlog while the window
   * was hidden — is spread over frames instead of jumping to completion.
   */
  private static readonly MAX_CHARS_PER_FRAME = 48;

  handle(event: ChatStreamEvent) {
    const rid = event.requestId;
    const expected = this.nextSeq.get(rid) ?? 0;

    // Ignore events already processed. Queue events that arrive ahead of a
    // missing sequence; a terminal event must never overtake text deltas.
    if (event.seq < expected) return;
    if (event.seq > expected) {
      const queue = this.queuedEvents.get(rid) ?? new Map<number, ChatStreamEvent>();
      queue.set(event.seq, event);
      this.queuedEvents.set(rid, queue);
      return;
    }

    this.process(event);
    let next = expected + 1;
    const queue = this.queuedEvents.get(rid);
    while (queue?.has(next)) {
      const queued = queue.get(next)!;
      queue.delete(next);
      this.process(queued);
      next += 1;
    }
    this.nextSeq.set(rid, next);
    if (queue?.size === 0) this.queuedEvents.delete(rid);
  }

  private process(event: ChatStreamEvent) {
    const store = useChatStore.getState();
    switch (event.type) {
      case "start":
        break;

      case "search_start":
        store.setSearchStatus(event.requestId, event.query);
        break;

      case "search_end":
        store.setSearchResults(event.requestId, event.results);
        break;

      case "tool_start":
        store.startToolCall(event.requestId, event.callId, event.name, event.arguments);
        break;

      case "tool_end":
        store.finishToolCall(event.requestId, event.callId, event.result);
        break;

      case "tool_error":
        store.failToolCall(event.requestId, event.callId, event.message);
        break;

      case "tool_pending":
        store.pendingToolCall(event.requestId, event.callId, event.name, event.summary);
        break;

      case "tool_rejected":
        store.rejectToolCall(event.requestId, event.callId);
        break;

      case "delta": {
        this.pending.set(
          event.requestId,
          (this.pending.get(event.requestId) ?? "") + event.text,
        );
        this.scheduleFlush();
        break;
      }

      case "reasoning_delta": {
        // Thinking traces are kept apart from the answer and rendered in a
        // collapsed block (bug fix: they used to leak into the content).
        this.pendingReasoning.set(
          event.requestId,
          (this.pendingReasoning.get(event.requestId) ?? "") + event.text,
        );
        this.scheduleFlush();
        break;
      }

      case "usage":
        store.setUsage(event.requestId, event.inputTokens, event.outputTokens);
        break;

      case "finish":
        // Defer finalization until the buffered deltas for this run have all
        // been rendered (see `pendingFinish` above). The frame loop drains a
        // bounded amount per frame, so a burst still appears incrementally.
        this.pendingFinish.set(event.requestId, event.reason);
        this.scheduleFlush();
        break;

      case "error":
        // Errors surface immediately, flushing any buffered deltas first so
        // the partial answer is shown alongside the error message.
        this.flushNow(true);
        store.onError(event.requestId, event.message, event.retryable);
        break;
    }
  }

  private scheduleFlush() {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.flushNow(false);
    });
  }

  private flushNow(force: boolean) {
    const store = useChatStore.getState();

    // Apply buffered deltas, throttled to MAX_CHARS_PER_FRAME per request per
    // frame. `force` (error termination) drains everything at once so the
    // partial answer plus the error message are shown together.
    this.drain(this.pending, force, (rid, text) => store.appendDelta(rid, text));
    this.drain(this.pendingReasoning, force, (rid, text) => store.appendReasoning(rid, text));

    // A deferred finish fires once its deltas have all been rendered.
    if (this.pendingFinish.size > 0) {
      for (const [requestId, reason] of [...this.pendingFinish.entries()]) {
        if (!this.pending.has(requestId) && !this.pendingReasoning.has(requestId)) {
          this.pendingFinish.delete(requestId);
          store.onFinish(requestId, reason);
        }
      }
    }

    // Keep scheduling while anything is still buffered so progress does not
    // stall waiting for the next event to arrive.
    if (
      this.pending.size > 0 ||
      this.pendingReasoning.size > 0 ||
      this.pendingFinish.size > 0
    ) {
      this.scheduleFlush();
    }
  }

  /** Consume up to `MAX_CHARS_PER_FRAME` characters from one buffer. */
  private drain(
    buffer: Map<string, string>,
    force: boolean,
    apply: (requestId: string, text: string) => void,
  ) {
    for (const [requestId, text] of [...buffer.entries()]) {
      if (text.length === 0) {
        buffer.delete(requestId);
        continue;
      }
      const take = force ? text.length : Math.min(text.length, DeltaBuffer.MAX_CHARS_PER_FRAME);
      apply(requestId, text.slice(0, take));
      const rest = text.slice(take);
      if (rest.length > 0) {
        buffer.set(requestId, rest);
      } else {
        buffer.delete(requestId);
      }
    }
  }
}

const buffer = new DeltaBuffer();
let unlisten: UnlistenFn | null = null;

export async function startStreamListener(): Promise<void> {
  if (unlisten) return;
  unlisten = await listen<ChatStreamEvent>("chat-event", (event) => {
    buffer.handle(event.payload);
  });
}

export function stopStreamListener(): void {
  unlisten?.();
  unlisten = null;
}
