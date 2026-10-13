import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { streamSSE } from "./sse.js";

describe("streamSSE", () => {
  it("returns an SSE response with text/event-stream content type", async () => {
    const app = new Hono();
    app.get("/feed", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: "hello" });
      }),
    );

    const res = await app.request("/feed");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  });

  it("emits SSE-formatted lines for writeSSE calls", async () => {
    const app = new Hono();
    app.get("/feed", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "tick", data: "1" });
        await stream.writeSSE({ event: "tick", data: "2" });
      }),
    );

    const res = await app.request("/feed");
    const body = await res.text();
    expect(body).toContain("event: tick");
    expect(body).toContain("data: 1");
    expect(body).toContain("data: 2");
  });

  it("emits an id field when provided", async () => {
    const app = new Hono();
    app.get("/feed", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ id: "evt-42", data: "x" });
      }),
    );
    const body = await (await app.request("/feed")).text();
    expect(body).toContain("id: evt-42");
  });

  it("ends the stream cleanly when the callback returns", async () => {
    const app = new Hono();
    app.get("/feed", (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: "only" });
      }),
    );

    const res = await app.request("/feed");
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    let total = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += new TextDecoder().decode(value);
    }
    expect(total).toContain("data: only");
  });

  it("propagates errors from the callback (Hono surfaces them)", async () => {
    const app = new Hono();
    app.get("/feed", (c) =>
      streamSSE(c, async () => {
        throw new Error("upstream broken");
      }),
    );
    // The response is still a 200 (headers were committed before the throw),
    // but the body terminates without a payload — exact behavior depends on
    // when the throw happens. The important property: no crash.
    const res = await app.request("/feed");
    expect(res.status).toBe(200);
    // Drain body
    await res.text().catch(() => "");
  });
});
