/**
 * Web Streams polyfills for the jsdom test environment.
 *
 * jsdom doesn't implement the Web Streams API, but `msw/node` (HTTP mocking)
 * references `TransformStream` & friends at import time. This module is the
 * FIRST import in `src/test-setup.ts` — ES module graphs evaluate imports
 * depth-first in declaration order, so Node's implementations are installed
 * before msw loads. (Don't rely on `setupFiles` ordering instead: vitest
 * loads setup files in parallel by default.)
 */
import {
  ReadableStream,
  TextDecoderStream,
  TextEncoderStream,
  TransformStream,
  WritableStream,
} from 'node:stream/web';

globalThis.TransformStream ??= TransformStream as unknown as typeof globalThis.TransformStream;
globalThis.ReadableStream ??= ReadableStream as unknown as typeof globalThis.ReadableStream;
globalThis.WritableStream ??= WritableStream as unknown as typeof globalThis.WritableStream;
globalThis.TextEncoderStream ??=
  TextEncoderStream as unknown as typeof globalThis.TextEncoderStream;
globalThis.TextDecoderStream ??=
  TextDecoderStream as unknown as typeof globalThis.TextDecoderStream;
