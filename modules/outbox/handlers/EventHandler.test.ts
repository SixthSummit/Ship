import { describe, expect, it, vi } from "vitest";
import { type EventHandler, EventHandlerRegistry, eventHandlerRegistry } from "./EventHandler.js";

function stubHandler(eventType: string, eventVersion?: number): EventHandler {
  return {
    eventType,
    eventVersion,
    handle: vi.fn(async () => undefined),
  };
}

describe("EventHandlerRegistry", () => {
  it("starts empty", () => {
    const r = new EventHandlerRegistry();
    expect(r.size()).toBe(0);
    expect(r.eventTypes()).toEqual([]);
  });

  it("register / hasHandler / findHandler round-trip", () => {
    const h = stubHandler("account.created");
    const r = new EventHandlerRegistry().register(h);
    expect(r.size()).toBe(1);
    expect(r.hasHandler("account.created")).toBe(true);
    expect(r.findHandler({ eventType: "account.created", eventVersion: 1 })).toBe(h);
  });

  it("findHandler returns undefined for unknown event types", () => {
    const r = new EventHandlerRegistry();
    expect(r.findHandler({ eventType: "missing", eventVersion: 1 })).toBeUndefined();
  });

  it("registers a version-agnostic handler with eventVersion omitted", () => {
    const h = stubHandler("account.created");
    const r = new EventHandlerRegistry().register(h);
    // Matches v1, v2, v999...
    expect(r.findHandler({ eventType: "account.created", eventVersion: 1 })).toBe(h);
    expect(r.findHandler({ eventType: "account.created", eventVersion: 999 })).toBe(h);
  });

  it("exact-version handler beats the version-agnostic fallback", () => {
    const v1 = stubHandler("account.created", 1);
    const fallback = stubHandler("account.created");
    const r = new EventHandlerRegistry().register(v1).register(fallback);
    expect(r.findHandler({ eventType: "account.created", eventVersion: 1 })).toBe(v1);
    // v2 falls through to fallback.
    expect(r.findHandler({ eventType: "account.created", eventVersion: 2 })).toBe(fallback);
  });

  it("rejects duplicate (eventType, version) registrations", () => {
    const r = new EventHandlerRegistry().register(stubHandler("a", 1));
    expect(() => r.register(stubHandler("a", 1))).toThrow(/duplicate/i);
  });

  it("allows different versions of the same eventType", () => {
    const r = new EventHandlerRegistry()
      .register(stubHandler("a", 1))
      .register(stubHandler("a", 2));
    expect(r.size()).toBe(2);
    expect(r.eventTypes()).toEqual(["a"]);
  });

  it("eventTypes() returns all registered event types", () => {
    const r = new EventHandlerRegistry()
      .register(stubHandler("a"))
      .register(stubHandler("b"))
      .register(stubHandler("c"));
    expect(r.eventTypes().sort()).toEqual(["a", "b", "c"]);
  });

  it("eventHandlerRegistry() factory builds populated registry in one call", () => {
    const r = eventHandlerRegistry(stubHandler("a"), stubHandler("b"), stubHandler("c", 1));
    expect(r.size()).toBe(3);
  });

  it("register is chainable", () => {
    const r = new EventHandlerRegistry();
    const ret = r.register(stubHandler("a")).register(stubHandler("b"));
    expect(ret).toBe(r);
  });
});
