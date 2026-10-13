import { Hono } from "hono";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { type LLMStreamEvent, streamLLM } from "./streamLLM.js";

/**
 * Drive `streamLLM` through an in-process Hono app and parse the SSE
 * body. Each SSE event is `id:`, `event:`, `data:` lines separated by
 * `\n` and terminated by a blank line.
 */
async function consumeSSE(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const event: SseEvent = { id: undefined, event: undefined, data: "" };
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("id:")) event.id = line.slice(3).trim();
      else if (line.startsWith("event:")) event.event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        event.data += (event.data ? "\n" : "") + line.slice(5).trim();
      }
    }
    events.push(event);
  }
  return events;
}

interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

function eventSource(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

describe("streamLLM (Hono SSE bridge)", () => {
  it("emits one SSE event per iterator value with type → event field", async () => {
    const app = new Hono().get("/chat", (c) =>
      streamLLM(
        c,
        eventSource([
          { type: "start", id: "msg_1", model: "claude-test" },
          { type: "text_delta", delta: "hel" },
          { type: "text_delta", delta: "lo" },
          { type: "stop", stopReason: "end_turn" },
        ]),
      ),
    );

    const res = await app.request("/chat");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const events = await consumeSSE(res);
    expect(events.map((e) => e.event)).toEqual(["start", "text_delta", "text_delta", "stop"]);
    expect(JSON.parse(events[0].data)).toEqual({
      id: "msg_1",
      model: "claude-test",
    });
    expect(JSON.parse(events[1].data)).toEqual({ delta: "hel" });
    expect(JSON.parse(events[3].data)).toEqual({ stopReason: "end_turn" });
  });

  it("auto-assigns monotonic event IDs (0, 1, 2, ...)", async () => {
    const app = new Hono().get("/chat", (c) =>
      streamLLM(c, eventSource([{ type: "a" }, { type: "b" }, { type: "c" }])),
    );

    const events = await consumeSSE(await app.request("/chat"));
    expect(events.map((e) => e.id)).toEqual(["0", "1", "2"]);
  });

  it("respects custom generateEventId option", async () => {
    const app = new Hono().get("/chat", (c) =>
      streamLLM(c, eventSource([{ type: "start" }, { type: "stop" }]), {
        generateEventId: (event, index) => `${event.type}-${index}`,
      }),
    );

    const events = await consumeSSE(await app.request("/chat"));
    expect(events.map((e) => e.id)).toEqual(["start-0", "stop-1"]);
  });

  it("emits a final `event: error` and closes when the iterator throws", async () => {
    const onError = vi.fn();
    const erroring = (async function* (): AsyncIterable<LLMStreamEvent> {
      yield { type: "start" };
      throw new Error("upstream blew up");
    })();
    const app = new Hono().get("/chat", (c) => streamLLM(c, erroring, { onError }));

    const events = await consumeSSE(await app.request("/chat"));
    expect(events.map((e) => e.event)).toEqual(["start", "error"]);
    expect(JSON.parse(events[1].data)).toEqual({ message: "upstream blew up" });
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0][0] as Error).message).toBe("upstream blew up");
  });

  it("calls iterator.return() on upstream error so providers can clean up", async () => {
    const returnSpy = vi.fn(async () => ({ done: true, value: undefined }));
    const errored: AsyncIterable<LLMStreamEvent> = {
      [Symbol.asyncIterator]() {
        let count = 0;
        return {
          async next() {
            count++;
            if (count === 1) return { done: false, value: { type: "start" } };
            throw new Error("network reset");
          },
          return: returnSpy,
        };
      },
    };
    const app = new Hono().get("/chat", (c) => streamLLM(c, errored));

    await consumeSSE(await app.request("/chat"));
    expect(returnSpy).toHaveBeenCalledOnce();
  });

  it("swallows throws from onError so the SSE close still completes", async () => {
    const onError = vi.fn(() => {
      throw new Error("hook is broken");
    });
    const erroring = (async function* (): AsyncIterable<LLMStreamEvent> {
      yield { type: "start" };
      throw new Error("upstream blew up");
    })();
    const app = new Hono().get("/chat", (c) => streamLLM(c, erroring, { onError }));

    const events = await consumeSSE(await app.request("/chat"));
    // Despite onError throwing, the error event is still written.
    expect(events.map((e) => e.event)).toEqual(["start", "error"]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("serializes nested JSON-friendly payloads correctly", async () => {
    const app = new Hono().get("/chat", (c) =>
      streamLLM(
        c,
        eventSource([
          {
            type: "tool_use_end",
            id: "tu_1",
            input: { city: "Paris", units: ["c", "f"] },
          },
        ]),
      ),
    );

    const events = await consumeSSE(await app.request("/chat"));
    expect(JSON.parse(events[0].data)).toEqual({
      id: "tu_1",
      input: { city: "Paris", units: ["c", "f"] },
    });
  });

  it("returns immediately on an empty event source (no events written)", async () => {
    const app = new Hono().get("/chat", (c) => streamLLM(c, eventSource([])));

    const res = await app.request("/chat");
    expect(res.status).toBe(200);
    const events = await consumeSSE(res);
    expect(events).toEqual([]);
  });

  describe("size cap (F15)", () => {
    function captureLogger() {
      const lines: Array<Record<string, unknown>> = [];
      const dest = {
        write(s: string) {
          lines.push(JSON.parse(s));
          return true;
        },
      };
      const logger = pino({ level: "debug" }, dest);
      return { logger, lines };
    }

    it("skips an oversized event + logs a warn line + passes the rest through", async () => {
      const { logger, lines } = captureLogger();
      const big = "X".repeat(300_000); // 300 KB > default 256 KB
      const app = new Hono().get("/chat", (c) =>
        streamLLM(
          c,
          eventSource([
            { type: "text_delta", delta: "ok" },
            { type: "tool_use", input: { huge: big } },
            { type: "stop" },
          ]),
          { logger: logger as never, provider: "anthropic" },
        ),
      );

      const res = await app.request("/chat");
      const events = await consumeSSE(res);
      // 3 emitted - 1 skipped = 2 received
      expect(events.map((e) => e.event)).toEqual(["text_delta", "stop"]);

      const warn = lines.find((l) => l.msg === "stream.event.dropped_oversized");
      expect(warn).toBeDefined();
      expect(warn!.eventType).toBe("tool_use");
      expect(warn!.provider).toBe("anthropic");
      expect(typeof warn!.eventBytes).toBe("number");
      expect((warn!.eventBytes as number) > 256_000).toBe(true);
      // sampleTail is a 256-char window from the end — not the full payload
      expect(typeof warn!.sampleTail).toBe("string");
      expect((warn!.sampleTail as string).length).toBeLessThanOrEqual(256);
    });

    it("respects a custom maxEventBytes (per-stream override)", async () => {
      const { logger, lines } = captureLogger();
      const app = new Hono().get("/chat", (c) =>
        streamLLM(
          c,
          eventSource([
            { type: "small", a: "x" }, // < 1 KB
            { type: "medium", a: "X".repeat(2000) }, // > 1 KB
          ]),
          { logger: logger as never, maxEventBytes: 1024 },
        ),
      );

      const res = await app.request("/chat");
      const events = await consumeSSE(res);
      expect(events.map((e) => e.event)).toEqual(["small"]);
      expect(lines.some((l) => l.msg === "stream.event.dropped_oversized")).toBe(true);
    });

    it("does not log or drop when every event is under the cap", async () => {
      const { logger, lines } = captureLogger();
      const app = new Hono().get("/chat", (c) =>
        streamLLM(
          c,
          eventSource([
            { type: "a", v: 1 },
            { type: "b", v: 2 },
          ]),
          { logger: logger as never },
        ),
      );

      const res = await app.request("/chat");
      const events = await consumeSSE(res);
      expect(events.map((e) => e.event)).toEqual(["a", "b"]);
      expect(lines.some((l) => l.msg === "stream.event.dropped_oversized")).toBe(false);
    });

    it("falls back to event.type as provider tag when opts.provider is unset", async () => {
      const { logger, lines } = captureLogger();
      const big = "X".repeat(300_000);
      const app = new Hono().get("/chat", (c) =>
        streamLLM(c, eventSource([{ type: "weird_event", huge: big }]), {
          logger: logger as never,
        }),
      );
      const res = await app.request("/chat");
      // Drain the response body so the streaming callback runs to
      // completion and the warn line is captured before assertion.
      await consumeSSE(res);

      const warn = lines.find((l) => l.msg === "stream.event.dropped_oversized");
      expect(warn?.provider).toBe("weird_event");
    });
  });
});
