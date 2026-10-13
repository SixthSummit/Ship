import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  hc,
  type InferResponseType,
  type PickResponseByStatusCode,
  type ShipApiClient,
} from "./client.js";

describe("typed client subpath (`@sixthsummit/ship-api/client`)", () => {
  it("`hc()` re-export drives a Hono app and infers response shape", async () => {
    const app = new Hono()
      .get("/me", (c) => c.json({ id: 1, email: "a@b.test" }, 200))
      .post("/echo", async (c) => {
        const body = (await c.req.json()) as { msg: string };
        return c.json({ echo: body.msg }, 200);
      });

    type AppType = typeof app;
    const client = hc<AppType>("http://localhost", {
      // Drive through the in-process app — no real HTTP listener needed.
      fetch: app.request.bind(app),
    });

    const meRes = await client.me.$get();
    expect(meRes.status).toBe(200);
    const me = await meRes.json();
    expect(me).toEqual({ id: 1, email: "a@b.test" });

    // Exercise the request-side type inference: `$post` only accepts a
    // body matching the route's expected shape, and the response narrows
    // to `{ echo: string }`. (TS at compile time; runtime asserts here.)
    const echoRes = await client.echo.$post({ json: { msg: "hi" } });
    expect(echoRes.status).toBe(200);
    const echoed = await echoRes.json();
    expect(echoed).toEqual({ echo: "hi" });
  });

  it("`InferResponseType` narrows the per-route return shape", async () => {
    const app = new Hono().get("/users/:id", (c) =>
      c.json({ id: c.req.param("id"), name: "Ada" }, 200),
    );
    type AppType = typeof app;
    const client = hc<AppType>("http://localhost", {
      fetch: app.request.bind(app),
    });
    type UserResponse = InferResponseType<(typeof client.users)[":id"]["$get"], 200>;

    const res = await client.users[":id"].$get({ param: { id: "1" } });
    expect(res.status).toBe(200);
    const sample: UserResponse = await res.json();
    expect(sample).toEqual({ id: "1", name: "Ada" });
  });

  it("`ShipApiClient<TApp>` alias is interchangeable with `ReturnType<hc<TApp>>`", async () => {
    const app = new Hono().get("/ping", (c) => c.json({ ok: true }, 200));
    type AppType = typeof app;
    type Direct = ReturnType<typeof hc<AppType>>;
    type Aliased = ShipApiClient<AppType>;

    const direct: Direct = hc<AppType>("http://localhost", {
      fetch: app.request.bind(app),
    });
    const aliased: Aliased = direct;
    const reassigned: Direct = aliased;

    const res = await reassigned.ping.$get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("a success-narrowed client drives requests at runtime (type guard in client.typecheck.ts)", async () => {
    // A route with both a success (200) and an error (400) response shape.
    const app = new Hono().get("/widget/:id", (c) => {
      if (c.req.param("id") === "missing") return c.json({ error: "not found" }, 400);
      return c.json({ id: c.req.param("id"), name: "w" }, 200);
    });

    // The success-only client (`ShipApiSuccessClient<typeof app>`) is `hc()` over
    // the 200|201-narrowed app type — the narrowing itself is type-checked in
    // client.typecheck.ts; here we just confirm it drives a real round-trip.
    const api = hc<PickResponseByStatusCode<typeof app, 200 | 201>>("http://localhost", {
      fetch: app.request.bind(app),
    });

    const res = await api.widget[":id"].$get({ param: { id: "1" } });
    const body: { id: string; name: string } = await res.json();
    expect(body).toEqual({ id: "1", name: "w" });
  });
});
