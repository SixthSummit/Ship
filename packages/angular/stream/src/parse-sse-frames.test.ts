import { describe, expect, it, vi } from 'vitest';
import { parseSseFrames, type SseFrame } from './parse-sse-frames';

function streamFromChunks(chunks: readonly (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    },
  });
}

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseFrames(stream, signal)) frames.push(frame);
  return frames;
}

describe('parseSseFrames', () => {
  it('parses CR, LF, CRLF, comments, fields without colons, and multiline data', async () => {
    const frames = await collect(
      streamFromChunks([
        ': comment\r',
        'event: update\r\ndata: first\ndata:second\runknown: ignored\r\n\r\n',
        'data\n\n',
      ])
    );

    expect(frames).toEqual([
      { event: 'update', data: 'first\nsecond', id: undefined, retry: undefined },
      { event: undefined, data: '', id: undefined, retry: undefined },
    ]);
  });

  it('keeps event IDs sticky, resets an empty ID, and ignores IDs containing null', async () => {
    const frames = await collect(
      streamFromChunks(['id: one\ndata: 1\n\ndata: 2\n\nid: bad\0id\ndata: 3\n\nid:\ndata: 4\n\n'])
    );

    expect(frames.map(frame => frame.id)).toEqual(['one', 'one', 'one', undefined]);
  });

  it('accepts only digit reconnect values and associates them with their frame', async () => {
    const frames = await collect(
      streamFromChunks(['retry: 1500\ndata: valid\n\nretry: -1\ndata: invalid\n\n'])
    );

    expect(frames.map(frame => frame.retry)).toEqual([1500, undefined]);
  });

  it('handles a UTF-8 BOM and a multibyte character split across chunks', async () => {
    const encoded = new TextEncoder().encode('\uFEFFdata: café\n\n');
    const split = encoded.indexOf(0xc3) + 1;
    const frames = await collect(streamFromChunks([encoded.slice(0, split), encoded.slice(split)]));

    expect(frames).toEqual([{ event: undefined, data: 'café', id: undefined, retry: undefined }]);
  });

  it('dispatches a complete trailing event when the stream ends without a blank line', async () => {
    await expect(collect(streamFromChunks(['event: final\ndata: value']))).resolves.toEqual([
      { event: 'final', data: 'value', id: undefined, retry: undefined },
    ]);
  });

  it('does not dispatch event-name-only or comment-only blocks', async () => {
    await expect(collect(streamFromChunks(['event: no-data\n\n: keepalive\n\n']))).resolves.toEqual(
      []
    );
  });

  it('cancels a pending reader when the signal aborts', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
      },
      cancel,
    });
    const controller = new AbortController();
    const frames: SseFrame[] = [];

    for await (const frame of parseSseFrames(stream, controller.signal)) {
      frames.push(frame);
      controller.abort();
    }

    expect(frames).toHaveLength(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('propagates reader failures to the owning stream capability', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new TypeError('reader failed');
      },
    });

    await expect(collect(stream)).rejects.toThrow(TypeError);
  });
});

describe('parseSseFrames wire contract framing', () => {
  it('ignores heartbeat comments between wire events and keeps numeric ids sticky', async () => {
    const frames = await collect(
      streamFromChunks([
        ': hb 1700000000000\n\n',
        'id: 1\nevent: frame\ndata: {"delta":"a"}\n\n',
        ': hb 1700000015000\n\n',
        'id: 2\nevent: terminal\ndata: null\n\n',
      ])
    );

    expect(frames).toEqual([
      { event: 'frame', data: '{"delta":"a"}', id: '1', retry: undefined },
      { event: 'terminal', data: 'null', id: '2', retry: undefined },
    ]);
  });

  it('reassembles a single event split across chunk boundaries at every field', async () => {
    const frames = await collect(
      streamFromChunks(['id', ': 7\nev', 'ent: fra', 'me\r\ndata: {"a":', '1}\r\n', '\r\n'])
    );

    expect(frames).toEqual([{ event: 'frame', data: '{"a":1}', id: '7', retry: undefined }]);
  });

  it('joins multi-line data with newlines for a wire error payload', async () => {
    const frames = await collect(
      streamFromChunks(['id: 9\nevent: error\ndata: {"code":"X",\ndata: "status":500}\n\n'])
    );

    expect(frames[0]?.data).toBe('{"code":"X",\n"status":500}');
  });
});

describe('parseSseFrames pinned byte details', () => {
  it('parses the canonical id/event/data field order verbatim', async () => {
    const frames = await collect(
      streamFromChunks([
        `id: 1\nevent: frame\ndata: ${JSON.stringify({ delta: 'a' })}\n\n`,
        `id: 2\nevent: terminal\ndata: ${JSON.stringify(null)}\n\n`,
      ])
    );

    expect(frames).toEqual([
      { event: 'frame', data: '{"delta":"a"}', id: '1', retry: undefined },
      { event: 'terminal', data: 'null', id: '2', retry: undefined },
    ]);
  });

  it('treats a bare `: hb <unix-ms>` heartbeat as nothing and leaves the sticky id alone', async () => {
    const frames = await collect(
      streamFromChunks([
        'id: 1\nevent: frame\ndata: {"delta":"a"}\n\n',
        `: hb ${Date.now()}\n\n`,
        `: hb ${Date.now() + 15_000}\n\n`,
        'id: 2\nevent: terminal\ndata: null\n\n',
      ])
    );

    expect(frames.map(frame => frame.id)).toEqual(['1', '2']);
    expect(frames.map(frame => frame.event)).toEqual(['frame', 'terminal']);
  });
});
