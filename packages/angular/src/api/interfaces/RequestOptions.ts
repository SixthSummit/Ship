import type { ApiOptions } from './ApiOptions';

/**
 * Extended options for requests that include a body
 */
export interface RequestOptions extends ApiOptions {
  body?: unknown;
}
