/** Black-box bridge contract. Only the fixture reference may implement cache behavior itself. */
export interface QueryConformanceSession {
  readonly clientIdentity: object;
  /** Delegate to the native isCancelledError predicate for imperative SSR reads. */
  isCancellation?(error: unknown): boolean;
  read(
    input: Record<string, unknown>,
    options?: { force?: boolean; signal?: AbortSignal }
  ): Promise<Envelope>;
  view(input: Record<string, unknown>): () => { data?: Envelope; error?: unknown };
  invalidate(input: Record<string, unknown>): Promise<unknown>;
  page(
    input: Record<string, unknown>,
    cursor: unknown
  ): Promise<{ pages: Envelope[]; pageParams: unknown[] }>;
  changeScope(scopeKey: string): Promise<unknown>;
  mutation(config?: MutationConfig): {
    execute(input: Record<string, unknown>): Promise<Envelope>;
    view(): { data?: Envelope; error?: unknown };
    destroy(): Promise<void>;
  };
  destroy(): Promise<void>;
}
export interface Envelope {
  data: unknown;
  result: unknown;
  etag?: string;
}
export interface Effects {
  isCurrent(): boolean;
  run(effect: () => void): boolean;
}
export interface MutationConfig {
  optimistic?: {
    apply(input: Record<string, unknown>, effects: Effects): unknown;
    rollback(snapshot: unknown, error: unknown, effects: Effects): unknown;
  };
  onSuccess?(envelope: Envelope, input: Record<string, unknown>, effects: Effects): unknown;
}
export type QueryConformanceAdapter = (config: {
  client: { call(operation: string, input: unknown, options?: unknown): Promise<unknown> };
  scopeKey: string;
  mode: 'browser' | 'server';
  requestSignal?: AbortSignal;
  requestHeaders?: Record<string, string>;
  policyRetry?: number;
}) => QueryConformanceSession | Promise<QueryConformanceSession>;
