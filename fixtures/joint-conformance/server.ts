import { createServer } from "node:http";
import { adapter } from "./app.js";
export async function startFixture() {
  const captures: Record<string, string>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(name, value);
    captures.push({
      ...Object.fromEntries(headers),
      __path: req.url ?? "",
      __method: req.method ?? "",
    });
    const origin = headers.get("origin");
    res.setHeader(
      "access-control-allow-origin",
      origin && /^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) ? origin : "*",
    );
    res.setHeader("access-control-allow-credentials", "true");
    if (req.url === "/__joint/session") {
      res.setHeader("set-cookie", "sid=browser-fixture; HttpOnly; SameSite=Lax; Path=/");
      res.end();
      return;
    }
    if (req.url === "/__joint/seen-status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(captures.some((h) => h.__path.startsWith("/status"))));
      return;
    }
    if (req.method === "OPTIONS") {
      res.setHeader(
        "access-control-allow-headers",
        headers.get("access-control-request-headers") ?? "content-type",
      );
      res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
      res.end();
      return;
    }
    const response = await adapter.fetch(
      new Request(`http://fixture.test${req.url}`, {
        method: req.method,
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    res.statusCode = response.status;
    response.headers.forEach((v, k) => {
      res.setHeader(k, v);
    });
    res.setHeader("access-control-expose-headers", "x-request-id");
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return {
    captures,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
