import { describe, expect, it } from 'vitest';
import { parseSseFrames, type SseFrame } from './sse-parser';

const streamFromString = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
};

const collect = async (stream: ReadableStream<Uint8Array>, signal?: AbortSignal) => {
  const out: SseFrame[] = [];
  for await (const f of parseSseFrames(stream, signal)) out.push(f);
  return out;
};

describe('parseSseFrames', () => {
  it('parses a single data-only frame', async () => {
    const frames = await collect(streamFromString(['data: hello\n\n']));
    expect(frames).toEqual([{ data: 'hello', event: undefined, id: undefined, retry: undefined }]);
  });

  it('parses an event-named frame', async () => {
    const frames = await collect(streamFromString(['event: greeting\ndata: hi\n\n']));
    expect(frames[0].event).toBe('greeting');
    expect(frames[0].data).toBe('hi');
  });

  it('joins multiple data lines with a newline', async () => {
    const frames = await collect(streamFromString(['data: line1\ndata: line2\ndata: line3\n\n']));
    expect(frames[0].data).toBe('line1\nline2\nline3');
  });

  it('parses id and retry fields', async () => {
    const frames = await collect(streamFromString(['id: 42\nretry: 5000\ndata: x\n\n']));
    expect(frames[0].id).toBe('42');
    expect(frames[0].retry).toBe(5000);
  });

  it('handles CRLF line endings', async () => {
    const frames = await collect(streamFromString(['data: x\r\ndata: y\r\n\r\n']));
    expect(frames[0].data).toBe('x\ny');
  });

  it('ignores SSE comments (lines starting with colon)', async () => {
    const frames = await collect(streamFromString([': keep-alive\ndata: x\n\n']));
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('x');
  });

  it('handles a chunk boundary in the middle of a line', async () => {
    const frames = await collect(streamFromString(['data: hel', 'lo world\n\n']));
    expect(frames).toEqual([
      { data: 'hello world', event: undefined, id: undefined, retry: undefined },
    ]);
  });

  it('handles a chunk boundary inside a frame separator', async () => {
    const frames = await collect(streamFromString(['data: a\n', '\ndata: b\n\n']));
    expect(frames).toHaveLength(2);
    expect(frames[0].data).toBe('a');
    expect(frames[1].data).toBe('b');
  });

  it('emits the trailing partial frame at end-of-stream', async () => {
    const frames = await collect(streamFromString(['data: x\n']));
    expect(frames).toEqual([{ data: 'x', event: undefined, id: undefined, retry: undefined }]);
  });

  it('drops unknown fields silently', async () => {
    const frames = await collect(streamFromString(['custom: ignore\ndata: x\n\n']));
    expect(frames[0].data).toBe('x');
    expect((frames[0] as unknown as Record<string, unknown>)['custom']).toBeUndefined();
  });

  it('strips a single leading space after the field colon', async () => {
    const frames = await collect(streamFromString(['data:no-space\ndata: with-space\n\n']));
    expect(frames[0].data).toBe('no-space\nwith-space');
  });

  it('respects an aborted signal — completes without throwing', async () => {
    const ctrl = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: a\n\n'));
        // Keep the stream open; never close.
      },
    });
    ctrl.abort();
    const frames = await collect(stream, ctrl.signal);
    // Aborted before reading — no frames yielded.
    expect(frames).toEqual([]);
  });
});
