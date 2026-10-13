import { describe, expect, it } from "vitest";
import { createSseParser } from "./sse.js";

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

describe("createSseParser", () => {
  it("parses id, event, and data fields in any order and defaults the event name", () => {
    const parser = createSseParser();
    expect(parser.push(bytes('id: 1\nevent: frame\ndata: {"a":1}\n\ndata: plain\n\n'))).toEqual([
      { id: "1", event: "frame", data: '{"a":1}' },
      { id: "1", event: "message", data: "plain" },
    ]);
  });

  it("joins multi-line data, ignores comments, and strips one leading space", () => {
    const parser = createSseParser();
    expect(parser.push(bytes(": hb 1700000000000\n\ndata:first\ndata:  second\n\n"))).toEqual([
      { event: "message", data: "first\n second" },
    ]);
  });

  it("reassembles events split across chunks and CRLF line endings", () => {
    const parser = createSseParser();
    const events = [
      ...parser.push(bytes("id: 7\r\nev")),
      ...parser.push(bytes("ent: frame\r")),
      ...parser.push(bytes('\ndata: {"x":')),
      ...parser.push(bytes("1}\r\n\r\n")),
    ];
    expect(events).toEqual([{ id: "7", event: "frame", data: '{"x":1}' }]);
  });

  it("does not dispatch events without data and drops an unterminated trailing event", () => {
    const parser = createSseParser();
    expect(parser.push(bytes("event: frame\nid: 3\n\n"))).toEqual([]);
    expect(parser.push(bytes("data: partial"))).toEqual([]);
    expect(parser.end()).toEqual([]);
  });

  it("flushes a lone carriage return terminator and ignores BOM and null ids", () => {
    const parser = createSseParser();
    expect(parser.push(bytes("﻿id: bad\0\ndata: x\r"))).toEqual([]);
    expect(parser.end()).toEqual([]);
    const flushed = createSseParser();
    expect(flushed.push(bytes("data: x\r\r"))).toEqual([]);
    expect(flushed.end()).toEqual([{ event: "message", data: "x" }]);
  });

  it("handles fields without a colon and multibyte characters across chunk boundaries", () => {
    const parser = createSseParser();
    const text = 'data: {"note":"héllo"}\n\n';
    const encoded = bytes(text);
    const events = [
      ...parser.push(encoded.slice(0, 15)),
      ...parser.push(encoded.slice(15)),
      ...parser.push(bytes("data\n\n")),
    ];
    expect(events).toEqual([
      { event: "message", data: '{"note":"héllo"}' },
      { event: "message", data: "" },
    ]);
  });
});
