/** Type-level CI contract for streaming handler arguments. */
import { z } from "zod";
import { publicAccess } from "./access.js";
import type { OperationStream } from "./operation.js";
import { defineOperation } from "./operation.js";

const frame = z.object({ index: z.number(), label: z.string().default("frame") });

const streaming = defineOperation({
  id: "fixtures.stream",
  transport: {
    kind: "fixture",
    response: {
      mode: "stream",
      framing: "sse",
      frame,
      heartbeatMs: 1,
      maxDurationMs: 1,
      maxFrames: 1,
    },
  },
  input: { body: z.object({ count: z.number() }) },
  output: { 200: z.object({ emitted: z.number() }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: async ({ input, stream }) => {
    const typedStream: OperationStream<{ index: number; label?: string }> = stream;
    const signal: AbortSignal = stream.signal;
    await stream.emit({ index: input.body.count });
    // @ts-expect-error frames are typed by the declared frame schema input
    await stream.emit({ index: "zero" });
    void typedStream;
    void signal;
    return { emitted: input.body.count };
  },
});

const unary = defineOperation({
  id: "fixtures.unary",
  input: {},
  output: { 200: z.object({ ok: z.literal(true) }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: (arguments_) => {
    const absent: undefined = arguments_.stream;
    void absent;
    return { ok: true as const };
  },
});

const declaredFrame: z.ZodObject<{ index: z.ZodNumber; label: z.ZodDefault<z.ZodString> }> =
  streaming.transport?.response.frame ?? frame;

void declaredFrame;
void unary;
