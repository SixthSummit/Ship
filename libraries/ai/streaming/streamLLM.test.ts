import { describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../types.js";
import { streamLLM } from "./streamLLM.js";

async function* provider(events: StreamEvent[], onReturn = vi.fn()): AsyncGenerator<StreamEvent> {
  try {
    for (const event of events) yield event;
  } finally {
    onReturn();
  }
}

function fixtureStream(controller = new AbortController()) {
  const emitted: unknown[] = [];
  return {
    emitted,
    controller,
    stream: {
      emit: vi.fn(async (frame: unknown) => void emitted.push(frame)),
      signal: controller.signal,
    },
  };
}

const startEvent: StreamEvent = { type: "start", id: "msg_1", model: "fixture" };
const deltaEvent: StreamEvent = { type: "text_delta", text: "hello" };
const stopEvent: StreamEvent = {
  type: "stop",
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe("streamLLM (kernel seam)", () => {
  it("emits every provider event as one frame and reports the count", async () => {
    const { stream, emitted } = fixtureStream();
    const result = await streamLLM(stream, provider([startEvent, deltaEvent, stopEvent]));
    expect(result).toEqual({ frames: 3, aborted: false });
    expect(emitted).toEqual([startEvent, deltaEvent, stopEvent]);
  });

  it("maps events with toFrame using the running index", async () => {
    const { stream, emitted } = fixtureStream();
    await streamLLM(stream, provider([deltaEvent, deltaEvent]), {
      toFrame: (event, index) => ({ type: event.type, index }),
    });
    expect(emitted).toEqual([
      { type: "text_delta", index: 0 },
      { type: "text_delta", index: 1 },
    ]);
  });

  it("stops and returns the provider iterator when the signal aborts", async () => {
    const onReturn = vi.fn();
    const { stream, controller } = fixtureStream();
    async function* endless(): AsyncGenerator<StreamEvent> {
      try {
        while (true) yield deltaEvent;
      } finally {
        onReturn();
      }
    }
    stream.emit.mockImplementation(async () => {
      controller.abort();
    });
    const result = await streamLLM(stream, endless());
    expect(result).toEqual({ frames: 1, aborted: true });
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("propagates provider failures after the onError hook and cleans up", async () => {
    const onReturn = vi.fn();
    const onError = vi.fn(async () => {
      throw new Error("hook failed");
    });
    async function* failing(): AsyncGenerator<StreamEvent> {
      try {
        yield startEvent;
        throw new Error("provider exploded");
      } finally {
        onReturn();
      }
    }
    const { stream } = fixtureStream();
    await expect(streamLLM(stream, failing(), { onError })).rejects.toThrow("provider exploded");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "provider exploded" }));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("propagates emit failures such as adapter-terminated streams", async () => {
    const { stream } = fixtureStream();
    stream.emit.mockRejectedValueOnce(new Error("stream closed"));
    await expect(streamLLM(stream, provider([startEvent, deltaEvent]))).rejects.toThrow(
      "stream closed",
    );
  });

  it("wraps non-Error provider throws", async () => {
    async function* failing(): AsyncGenerator<StreamEvent> {
      yield startEvent;
      throw "plain";
    }
    const { stream } = fixtureStream();
    await expect(streamLLM(stream, failing())).rejects.toThrow("plain");
  });
});
