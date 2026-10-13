import type { OperationId } from './operation-contract';

export interface CredentialRequest<TContract extends object> {
  readonly operation: OperationId<TContract>;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export interface AnonymousCredentialCapability {
  readonly kind: 'anonymous';
}

export interface BearerCredentialCapability<TContract extends object> {
  readonly kind: 'bearer';
  readonly getToken: (request: CredentialRequest<TContract>) => Promise<string | null>;
  /** Explicitly refresh provider state. Called at most once only when operation policy opts in. */
  readonly refresh?: (request: CredentialRequest<TContract>) => Promise<void>;
  readonly headerName?: string;
  readonly scheme?: string;
}

export interface CookieCredentialCapability<TContract extends object> {
  readonly kind: 'cookie';
  readonly credentials?: 'include' | 'same-origin';
  readonly getCsrfToken?: (request: CredentialRequest<TContract>) => Promise<string | null>;
  /** Explicitly refresh the server session. Never inferred from an ordinary denial. */
  readonly refresh?: (request: CredentialRequest<TContract>) => Promise<void>;
  readonly csrfHeaderName?: string;
}

/** Current credential source resolved separately for every attempt or reconnect. */
export type CredentialCapability<TContract extends object> =
  | AnonymousCredentialCapability
  | BearerCredentialCapability<TContract>
  | CookieCredentialCapability<TContract>;
