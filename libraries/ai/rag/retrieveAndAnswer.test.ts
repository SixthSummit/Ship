import { describe, expect, it, vi } from "vitest";
import type { LLMProvider } from "../adapters/LLMProvider.js";
import { definePrompt } from "../prompts/definePrompt.js";
import type { CompleteOptions, CompleteResult, StreamEvent } from "../types.js";
import {
  type RetrievedDocument,
  retrieveAndAnswer,
  type VectorStore,
} from "./retrieveAndAnswer.js";

function buildLLM(text: string): {
  llm: LLMProvider;
  completeSpy: ReturnType<typeof vi.fn>;
} {
  const completeSpy = vi.fn(
    async (_opts: CompleteOptions): Promise<CompleteResult> => ({
      id: "msg_1",
      model: "claude-test",
      content: [{ type: "text", text }],
      text,
      stopReason: "end_turn",
      usage: { inputTokens: 50, outputTokens: 12 },
    }),
  );
  return {
    llm: {
      name: "stub",
      complete: completeSpy as unknown as LLMProvider["complete"],
      async *streamComplete(): AsyncIterable<StreamEvent> {},
    },
    completeSpy,
  };
}

function buildVectorStore(docs: RetrievedDocument[]): {
  store: VectorStore;
  searchSpy: ReturnType<typeof vi.fn>;
} {
  const searchSpy = vi.fn(async () => docs);
  return {
    store: {
      name: "stub-store",
      search: searchSpy as unknown as VectorStore["search"],
    },
    searchSpy,
  };
}

const baseDocs: RetrievedDocument[] = [
  { id: "doc-1", text: "Paris is the capital of France.", score: 0.92 },
  { id: "doc-2", text: "Population of Paris is roughly 2.1M.", score: 0.85 },
];

describe("retrieveAndAnswer", () => {
  it("retrieves topK and formats numbered citation markers in the prompt", async () => {
    const { llm, completeSpy } = buildLLM("Paris [1].");
    const { store, searchSpy } = buildVectorStore(baseDocs);

    const result = await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "What is the capital of France?",
      model: "claude-test",
    });

    // search called with default topK=5
    expect(searchSpy).toHaveBeenCalledOnce();
    const searchArgs = searchSpy.mock.calls[0][0];
    expect(searchArgs.query).toBe("What is the capital of France?");
    expect(searchArgs.topK).toBe(5);

    // user prompt must contain both citation markers + document text
    const completeOpts = completeSpy.mock.calls[0][0] as CompleteOptions;
    const userMsg = completeOpts.messages[0];
    expect(userMsg.role).toBe("user");
    const userText = userMsg.content as string;
    expect(userText).toContain("[1] (doc-1) Paris is the capital of France.");
    expect(userText).toContain("[2] (doc-2) Population of Paris is roughly 2.1M.");
    expect(userText).toContain("What is the capital of France?");

    expect(result.answer).toBe("Paris [1].");
    expect(result.sources).toEqual(baseDocs);
    expect(result.raw.id).toBe("msg_1");
  });

  it("respects custom topK", async () => {
    const { llm } = buildLLM("ok");
    const { store, searchSpy } = buildVectorStore(baseDocs);

    await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "x",
      topK: 3,
      model: "claude-test",
    });
    expect(searchSpy.mock.calls[0][0].topK).toBe(3);
  });

  it("uses the documented default system prompt", async () => {
    const { llm, completeSpy } = buildLLM("ok");
    const { store } = buildVectorStore(baseDocs);

    await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "x",
      model: "claude-test",
    });
    const opts = completeSpy.mock.calls[0][0] as CompleteOptions;
    expect(opts.system).toContain("documents provided");
    expect(opts.system).toContain("Cite document numbers");
  });

  it("custom systemPrompt overrides the default", async () => {
    const { llm, completeSpy } = buildLLM("ok");
    const { store } = buildVectorStore(baseDocs);

    await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "x",
      model: "claude-test",
      systemPrompt: "Be terse.",
    });
    const opts = completeSpy.mock.calls[0][0] as CompleteOptions;
    expect(opts.system).toBe("Be terse.");
  });

  it("forwards filter / maxTokens / temperature / signal to both store and llm", async () => {
    const { llm, completeSpy } = buildLLM("ok");
    const { store, searchSpy } = buildVectorStore(baseDocs);
    const ac = new AbortController();

    await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "x",
      model: "claude-test",
      filter: { tenantId: "t_42" },
      maxTokens: 256,
      temperature: 0.1,
      signal: ac.signal,
    });

    const searchArgs = searchSpy.mock.calls[0][0];
    expect(searchArgs.filter).toEqual({ tenantId: "t_42" });
    expect(searchArgs.signal).toBe(ac.signal);

    const completeOpts = completeSpy.mock.calls[0][0] as CompleteOptions;
    expect(completeOpts.maxTokens).toBe(256);
    expect(completeOpts.temperature).toBe(0.1);
    expect(completeOpts.signal).toBe(ac.signal);
  });

  it("handles empty retrieval — model is told no documents were available", async () => {
    const { llm, completeSpy } = buildLLM("Sorry, no source material.");
    const { store } = buildVectorStore([]);

    const result = await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "obscure question",
      model: "claude-test",
    });

    const userText = (completeSpy.mock.calls[0][0] as CompleteOptions).messages[0]
      .content as string;
    expect(userText).toContain("no documents retrieved");
    expect(result.sources).toEqual([]);
  });

  it("respects custom formatDocument formatter", async () => {
    const { llm, completeSpy } = buildLLM("ok");
    const { store } = buildVectorStore(baseDocs);

    await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "x",
      model: "claude-test",
      formatDocument: (doc) => `### ${doc.id}\n${doc.text}`,
    });

    const userText = (completeSpy.mock.calls[0][0] as CompleteOptions).messages[0]
      .content as string;
    expect(userText).toContain("### doc-1\nParis is the capital of France.");
    expect(userText).toContain("### doc-2\nPopulation of Paris is roughly 2.1M.");
    // Default citation markers should NOT be present.
    expect(userText).not.toContain("[1] (doc-1)");
  });

  it("respects custom promptTemplate", async () => {
    const { llm, completeSpy } = buildLLM("ok");
    const { store } = buildVectorStore(baseDocs);

    const customPrompt = definePrompt({
      id: "test.custom_rag",
      version: 1,
      template: "Q: {{query}}\nDocs: {{documents}}\nReply in one sentence.",
    });

    await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "where is paris",
      model: "claude-test",
      promptTemplate: customPrompt,
    });

    const userText = (completeSpy.mock.calls[0][0] as CompleteOptions).messages[0]
      .content as string;
    expect(userText).toMatch(/^Q: where is paris/);
    expect(userText).toContain("Reply in one sentence.");
  });

  it("returns sources unchanged for citation surfacing in UI", async () => {
    const { llm } = buildLLM("answer");
    const docs = baseDocs.map((d) => ({
      ...d,
      metadata: { url: `https://example.com/${d.id}` },
    }));
    const { store } = buildVectorStore(docs);

    const result = await retrieveAndAnswer({
      llm,
      vectorStore: store,
      query: "x",
      model: "claude-test",
    });
    expect(result.sources).toBe(docs);
    expect(result.sources[0].metadata).toEqual({
      url: "https://example.com/doc-1",
    });
  });
});
