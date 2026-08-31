import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaBuffer } from "../stream-events";
import { useChatStore } from "../../stores/chat-store";
import type { ChatStreamEvent } from "../../types";

/**
 * The DeltaBuffer throttles how much text reaches the UI per animation frame
 * and defers `finish` until the buffered deltas have been rendered, so an
 * endpoint that returns the whole answer in one burst still appears
 * incrementally instead of jumping straight to the final text.
 */

let rafCallback: FrameRequestCallback | null = null;

function nextFrame() {
  const cb = rafCallback;
  rafCallback = null;
  cb?.(0);
}

/** Drain every frame scheduled so far (loops over re-schedules). */
function drainAllFrames(maxFrames = 200): number {
  let frames = 0;
  while (rafCallback && frames < maxFrames) {
    nextFrame();
    frames += 1;
  }
  return frames;
}

function startStreaming() {
  useChatStore.setState({
    messages: [],
    streamingRequestId: "req-1",
    streamingMessageId: "msg-1",
    streamingMessage: {
      id: "msg-1",
      role: "assistant",
      content: "",
      status: "streaming",
    },
  });
}

function delta(text: string, seq = 0): ChatStreamEvent {
  return { type: "delta", seq, requestId: "req-1", text };
}

function finish(seq = 1, reason?: string): ChatStreamEvent {
  return { type: "finish", seq, requestId: "req-1", reason };
}

beforeEach(() => {
  rafCallback = null;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCallback = cb;
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  startStreaming();
});

describe("DeltaBuffer incremental rendering", () => {
  it("renders a whole-response burst across multiple frames, then finalizes", () => {
    const buffer = new DeltaBuffer();
    const longText = "a".repeat(200); // 200 chars, 48 per frame → ≥ 5 frames

    buffer.handle(delta(longText));
    buffer.handle(finish());

    // Nothing applied yet — deltas are held for the frame loop.
    expect(useChatStore.getState().streamingMessage?.content).toBe("");

    const frames = drainAllFrames();

    // Finished only after every buffered character reached the store.
    const state = useChatStore.getState();
    expect(state.streamingMessage).toBeNull();
    expect(state.messages[0]).toMatchObject({ content: longText, status: "done" });
    expect(frames).toBeGreaterThan(1);
  });

  it("applies a small delta in a single frame without holding the finish", () => {
    const buffer = new DeltaBuffer();
    buffer.handle(delta("你好"));
    buffer.handle(finish());

    nextFrame();

    const state = useChatStore.getState();
    expect(state.messages[0]).toMatchObject({ content: "你好", status: "done" });
  });

  it("interleaves reasoning deltas with content deltas, throttling both", () => {
    const buffer = new DeltaBuffer();
    const reasoning = "r".repeat(120);
    const content = "c".repeat(120);

    buffer.handle({ type: "reasoning_delta", seq: 0, requestId: "req-1", text: reasoning });
    buffer.handle(delta(content, 1));
    buffer.handle(finish(2));

    drainAllFrames();

    const final = useChatStore.getState().messages[0];
    expect(final.content).toBe(content);
    expect(final.reasoning).toBe(reasoning);
    expect(final.status).toBe("done");
  });

  it("holds an out-of-order finish until missing deltas arrive", () => {
    const buffer = new DeltaBuffer();
    buffer.handle(delta("你", 0));
    buffer.handle(finish(2));
    buffer.handle(delta("好，完整回答", 1));

    drainAllFrames();

    const state = useChatStore.getState();
    expect(state.messages[0]).toMatchObject({ content: "你好，完整回答", status: "done" });
  });

  it("ignores duplicate sequence events", () => {
    const buffer = new DeltaBuffer();
    buffer.handle(delta("你好", 0));
    buffer.handle(delta("重复", 0));
    buffer.handle(finish(1));

    drainAllFrames();

    expect(useChatStore.getState().messages[0]?.content).toBe("你好");
  });

  it("flushes all buffered text immediately on error", () => {
    const buffer = new DeltaBuffer();
    buffer.handle(delta("partial answer"));
    buffer.handle({
      type: "error",
      seq: 1,
      requestId: "req-1",
      code: "stream_error",
      message: "boom",
      retryable: true,
    });

    const final = useChatStore.getState().messages[0];
    expect(final.content).toBe("partial answer");
    expect(final.status).toBe("error");
    expect(final.error).toBe("boom");
    expect(final.retryable).toBe(true);
  });
});
