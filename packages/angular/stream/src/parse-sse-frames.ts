export interface SseFrame {
  readonly event?: string;
  readonly data: string;
  /** Sticky SSE event ID after applying this frame. */
  readonly id?: string;
  /** Valid server-suggested reconnect delay carried by this frame. */
  readonly retry?: number;
}

interface PendingFrame {
  event?: string;
  readonly data: string[];
  retry?: number;
}

/** Parse WHATWG SSE frames across arbitrary UTF-8 and line-ending chunk boundaries. */
export async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstText = true;
  let pending: PendingFrame = { data: [] };
  let lastEventId = '';
  const abortReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abortReader, { once: true });

  const processLine = (line: string): SseFrame | undefined => {
    if (line === '') {
      if (pending.data.length === 0) {
        pending = { data: [] };
        return undefined;
      }
      const event = pending.event === '' ? undefined : pending.event;
      const id = lastEventId === '' ? undefined : lastEventId;
      const frame: SseFrame = {
        data: pending.data.join('\n'),
        ...(event === undefined ? {} : { event }),
        ...(id === undefined ? {} : { id }),
        ...(pending.retry === undefined ? {} : { retry: pending.retry }),
      };
      pending = { data: [] };
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        pending.event = value;
        break;
      case 'data':
        pending.data.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) pending.retry = Number.parseInt(value, 10);
        break;
    }
    return undefined;
  };

  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
      } else {
        let text = decoder.decode(value, { stream: true });
        if (firstText) {
          firstText = false;
          if (text.startsWith('\uFEFF')) text = text.slice(1);
        }
        buffer += text;
      }

      while (true) {
        const next = takeSseLine(buffer, done);
        if (next === undefined) break;
        buffer = next.rest;
        const frame = processLine(next.line);
        if (frame !== undefined) yield frame;
      }

      if (done) {
        const finalFrame = processLine('');
        if (finalFrame !== undefined) yield finalFrame;
        return;
      }
    }
  } finally {
    signal?.removeEventListener('abort', abortReader);
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        // Cancellation is best-effort after the owning operation has aborted.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A canceled implementation may have already released the reader.
    }
  }
}

function takeSseLine(
  buffer: string,
  endOfStream: boolean
): { readonly line: string; readonly rest: string } | undefined {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character === '\n') {
      return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) };
    }
    if (character === '\r') {
      if (index === buffer.length - 1 && !endOfStream) return undefined;
      const width = buffer[index + 1] === '\n' ? 2 : 1;
      return { line: buffer.slice(0, index), rest: buffer.slice(index + width) };
    }
  }
  if (endOfStream && buffer.length > 0) return { line: buffer, rest: '' };
  return undefined;
}
