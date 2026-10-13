import type { LLMProvider } from "../adapters/LLMProvider.js";
import { definePrompt, type Prompt } from "../prompts/definePrompt.js";
import type { CompleteResult, Message } from "../types.js";

/**
 * `retrieveAndAnswer({ llm, vectorStore, query, ... })` — RAG pipeline
 * primitive per plan §G. Retrieves the top-k relevant documents from a
 * `VectorStore`, formats them into a context block, and asks the
 * `LLMProvider` to answer the query grounded in those documents.
 *
 * Pluggable on both axes:
 *   - `LLMProvider` is the cross-provider interface from
 *     `adapters/LLMProvider.ts` — Anthropic / OpenAI / future
 *     adapters all work identically.
 *   - `VectorStore` is a structural interface defined here. The
 *     library deliberately takes no dep on `libraries/weaviate` or
 *     any specific store — consumers pass their own implementation
 *     (Weaviate, Pinecone, in-memory, Postgres pgvector, …). Keeping
 *     the dep narrow means the RAG helper is usable with any
 *     retrieval backend the consumer happens to have.
 *
 * The prompt is overridable: callers can pass their own
 * `Prompt<{ query, documents }>` to swap the template (e.g., domain-
 * specific framing, multi-language). The default produces the
 * standard "answer the question using only the documents below"
 * template most RAG flows want.
 *
 * Output shape: `{ answer, sources, raw }`. `sources` is the original
 * `RetrievedDocument[]` (id + score + metadata), so callers can
 * surface citations in their UI without re-querying.
 */

export interface RetrievedDocument {
  /** Stable identifier — surfaced as a citation marker in the prompt. */
  id: string;
  /** The text the model sees. */
  text: string;
  /** Similarity / relevance score from the store. Higher is better. */
  score: number;
  /** Free-form metadata (source URL, author, timestamp, …). */
  metadata?: Record<string, unknown>;
}

export interface VectorStoreSearchOptions {
  query: string;
  /** Caller-defined ceiling on retrieved document count. */
  topK: number;
  /**
   * Optional store-specific filter (e.g. tenant scoping). Pass
   * unchanged to the underlying store.
   */
  filter?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface VectorStore {
  /** Stable identifier ("weaviate", "pinecone", "pgvector", …). */
  readonly name: string;
  /** Retrieve the top-k most relevant documents for the given query. */
  search(opts: VectorStoreSearchOptions): Promise<RetrievedDocument[]>;
}

export interface RetrieveAndAnswerOptions {
  /** Provider that produces the final answer. */
  llm: LLMProvider;
  /** Vector store to query. */
  vectorStore: VectorStore;
  /** The user question. */
  query: string;
  /** Top-k documents to retrieve. Default 5. */
  topK?: number;
  /** Model id forwarded to `llm.complete`. */
  model: string;
  /**
   * Top-level system prompt. Defaults to a faithful-attribution
   * instruction; override to add tone / domain framing.
   */
  systemPrompt?: string;
  /**
   * Override the prompt template. Receives `{ query, documents }`
   * (`documents` is the formatted context block). Defaults to the
   * built-in `RAG_DEFAULT_PROMPT`.
   */
  promptTemplate?: Prompt<{ query: string; documents: string }>;
  /**
   * Filter forwarded to `vectorStore.search` — store-specific
   * (tenant scoping, time range, …).
   */
  filter?: Record<string, unknown>;
  /**
   * Per-document context formatter. Defaults to numbered citation
   * markers (`[1]`, `[2]`, …) that the model can cite back. Pass a
   * custom formatter for richer formatting (markdown headers,
   * metadata interpolation, …).
   */
  formatDocument?: (doc: RetrievedDocument, index: number) => string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Provider-native passthrough forwarded to `llm.complete` (e.g. prompt
   * caching for the system prompt / documents). Without it the seam's
   * pass-through never reaches the adapter through RAG (AI-R1).
   */
  providerOptions?: Record<string, unknown>;
  /** Request-tagging forwarded to `llm.complete` for observability / cost tracking. */
  metadata?: Record<string, string>;
}

export interface RetrieveAndAnswerResult {
  /** The model's answer text (joined `text` content parts). */
  answer: string;
  /** Documents the answer was grounded in, in retrieval order. */
  sources: RetrievedDocument[];
  /** The raw provider response (id / model / usage / etc.). */
  raw: CompleteResult;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_SYSTEM_PROMPT =
  "You are a careful assistant. Answer the user's question using only the documents provided. If the documents don't contain the answer, say so explicitly. Cite document numbers (e.g. [1], [2]) for any claim sourced from a document.";

export const RAG_DEFAULT_PROMPT = definePrompt({
  id: "ship-api.rag.retrieve_and_answer",
  version: 1,
  template:
    "Question:\n{{query}}\n\nDocuments:\n{{documents}}\n\nAnswer the question using only the documents above. Cite document numbers in square brackets for each claim sourced from a document.",
  description: "Default RAG prompt — grounded answer with citations.",
});

export async function retrieveAndAnswer(
  opts: RetrieveAndAnswerOptions,
): Promise<RetrieveAndAnswerResult> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const formatDocument = opts.formatDocument ?? defaultDocumentFormatter;
  const promptTemplate = opts.promptTemplate ?? RAG_DEFAULT_PROMPT;

  const sources = await opts.vectorStore.search({
    query: opts.query,
    topK,
    filter: opts.filter,
    signal: opts.signal,
  });

  const documentsBlock = sources.map((doc, i) => formatDocument(doc, i)).join("\n\n");

  const userPrompt = promptTemplate.render({
    query: opts.query,
    documents:
      sources.length === 0
        ? "(no documents retrieved — answer should explicitly say no source material was available)"
        : documentsBlock,
  });

  const messages: Message[] = [{ role: "user", content: userPrompt }];

  const raw = await opts.llm.complete({
    model: opts.model,
    messages,
    system: opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    signal: opts.signal,
    providerOptions: opts.providerOptions,
    metadata: opts.metadata,
  });

  return {
    answer: raw.text,
    sources,
    raw,
  };
}

function defaultDocumentFormatter(doc: RetrievedDocument, index: number): string {
  return `[${index + 1}] (${doc.id}) ${doc.text}`;
}
