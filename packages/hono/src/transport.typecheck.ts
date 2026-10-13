import { z } from "zod";
import { http } from "./transport.js";

const readTransport = http.get("/fixtures/:fixtureId");
const exactBinding: "GET /fixtures/:fixtureId" = readTransport.binding;
const exactMethod: "GET" = readTransport.metadata.method;
const exactPath: "/fixtures/:fixtureId" = readTransport.metadata.path;
const exactResponse: "json" = readTransport.metadata.response;

const download = http.get("/fixtures/:fixtureId/download", {
  response: "binary",
  contentType: "application/pdf",
});
const binaryResponse: "binary" = download.metadata.response;
http.get("/export", { response: "binary", contentTypes: ["text/csv", "application/pdf"] });

// @ts-expect-error only binary responses may declare alternative content types
http.get("/not-binary", { response: "text", contentTypes: ["text/csv", "application/pdf"] });

http.route("PATCH", "/fixtures/:fixtureId");

// @ts-expect-error unsupported methods are rejected at declaration time
http.route("TRACE", "/fixtures");

void exactBinding;
void exactMethod;
void exactPath;
void exactResponse;
void binaryResponse;

const streamFrame = z.object({ step: z.number() });
const streaming = http.post("/streams", {
  response: {
    mode: "stream",
    framing: "sse",
    frame: streamFrame,
    heartbeatMs: 1000,
    maxDurationMs: 5000,
    maxFrames: 10,
  },
});
const streamMode: "stream" = streaming.metadata.response;
const declaredFrame: typeof streamFrame = streaming.response.frame;
const unaryResponse: undefined = readTransport.response;

http.post("/streams-typed", {
  response: { mode: "stream", framing: "sse", frame: streamFrame },
  // @ts-expect-error streams cannot override the SSE content type
  contentType: "text/plain",
});

http.post("/streams-alternatives", {
  response: { mode: "stream", framing: "sse", frame: streamFrame },
  // @ts-expect-error streams cannot declare alternative content types
  contentTypes: ["text/csv", "application/pdf"],
});

void streamMode;
void declaredFrame;
void unaryResponse;
