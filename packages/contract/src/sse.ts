/**
 * Incremental Server-Sent Events parser following the WHATWG EventSource
 * framing rules. Browser-safe: it depends only on `TextDecoder`.
 */
export interface SseParsedEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
}

export interface SseParser {
  /** Feeds bytes and returns every event completed by them, in order. */
  push(chunk: Uint8Array): SseParsedEvent[];
  /** Signals end of input; an unterminated trailing event is discarded per spec. */
  end(): SseParsedEvent[];
}

export function createSseParser(): SseParser {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let id: string | undefined;
  let hasData = false;

  const dispatch = (): SseParsedEvent | undefined => {
    const event = hasData
      ? {
          event: eventName || "message",
          data: dataLines.join("\n"),
          ...(id === undefined ? {} : { id }),
        }
      : undefined;
    eventName = "";
    dataLines = [];
    hasData = false;
    return event;
  };

  const consumeLine = (line: string): SseParsedEvent | undefined => {
    if (line.length === 0) return dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") eventName = value;
    else if (field === "data") {
      dataLines.push(value);
      hasData = true;
    } else if (field === "id" && !value.includes("\0")) id = value;
    return undefined;
  };

  const drain = (flush: boolean): SseParsedEvent[] => {
    const events: SseParsedEvent[] = [];
    let start = 0;
    while (start < buffer.length) {
      const lineFeed = buffer.indexOf("\n", start);
      const carriageReturn = buffer.indexOf("\r", start);
      let end: number;
      let skip: number;
      if (carriageReturn !== -1 && (lineFeed === -1 || carriageReturn < lineFeed)) {
        if (carriageReturn === buffer.length - 1 && !flush) break;
        end = carriageReturn;
        skip = buffer[carriageReturn + 1] === "\n" ? 2 : 1;
      } else if (lineFeed !== -1) {
        end = lineFeed;
        skip = 1;
      } else {
        break;
      }
      const event = consumeLine(buffer.slice(start, end));
      if (event) events.push(event);
      start = end + skip;
    }
    buffer = buffer.slice(start);
    return events;
  };

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.charCodeAt(0) === 0xfeff) buffer = buffer.slice(1);
      return drain(false);
    },
    end() {
      buffer += decoder.decode();
      const events = drain(true);
      if (buffer.length > 0) {
        // A final line without a terminator is still a line; the event it
        // belongs to is only dispatched by a blank line, so it is dropped.
        consumeLine(buffer);
        buffer = "";
      }
      return events;
    },
  };
}
