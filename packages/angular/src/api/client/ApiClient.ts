import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { HttpRequestError } from '../errors/HttpRequestError';
import type { ApiOptions } from '../interfaces/ApiOptions';
import type { RequestOptions } from '../interfaces/RequestOptions';

/**
 * Imperative HTTP client for one-shot calls (form submissions, mutations,
 * fire-and-forget actions). Returns Promises.
 *
 * For component data binding, prefer {@link createResource} — it returns a
 * reactive {@link ShipResource} whose `value` is a `Signal<T>`. `ApiClient`
 * is for the cases where a Promise is the right shape (event handlers,
 * sequential awaits, error handling with try/catch).
 *
 * Auth headers are attached automatically by the registered
 * {@link authInterceptor}; this class no longer manages tokens directly.
 *
 * @example
 * ```ts
 * private api = inject(ApiClient);
 *
 * async onSave(payload: User) {
 *   await this.api.post('/api/users', payload);
 * }
 * ```
 */
@Injectable({ providedIn: 'root' })
export default class ApiClient {
  private readonly httpClient = inject(HttpClient);

  /**
   * Make an HTTP request. Returns the parsed body. Throws on non-2xx.
   */
  async request<T>(method: string, url: string, options: RequestOptions = {}): Promise<T> {
    try {
      const shared = {
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
        ...(options.params === undefined ? {} : { params: options.params }),
        ...(options.reportProgress === undefined ? {} : { reportProgress: options.reportProgress }),
        ...(options.withCredentials === undefined
          ? {}
          : { withCredentials: options.withCredentials }),
      };
      const responseType = options.responseType ?? 'json';
      const result =
        responseType === 'blob'
          ? await firstValueFrom(
              this.httpClient.request(method, url, { ...shared, responseType: 'blob' })
            )
          : responseType === 'arraybuffer'
            ? await firstValueFrom(
                this.httpClient.request(method, url, { ...shared, responseType: 'arraybuffer' })
              )
            : responseType === 'text'
              ? await firstValueFrom(
                  this.httpClient.request(method, url, { ...shared, responseType: 'text' })
                )
              : await firstValueFrom(
                  this.httpClient.request<T>(method, url, { ...shared, responseType: 'json' })
                );
      // Angular expresses response type through overloads while this compatibility
      // client retains its historical caller-supplied T. The runtime branch above is
      // the single bridge; new operation/download APIs infer their result directly.
      return result as T;
    } catch (error: unknown) {
      if (error instanceof HttpErrorResponse) {
        throw HttpRequestError.fromHttpErrorResponse(error);
      }
      throw error;
    }
  }

  /** HTTP DELETE. */
  delete<T>(url: string, options: ApiOptions = {}): Promise<T> {
    return this.request<T>('DELETE', url, options);
  }

  /** HTTP GET. */
  get<T>(url: string, options: ApiOptions = {}): Promise<T> {
    return this.request<T>('GET', url, options);
  }

  /** HTTP PATCH. */
  patch<T>(url: string, body: unknown, options: ApiOptions = {}): Promise<T> {
    return this.request<T>('PATCH', url, { ...options, body });
  }

  /** HTTP POST. */
  post<T>(url: string, body: unknown, options: ApiOptions = {}): Promise<T> {
    return this.request<T>('POST', url, { ...options, body });
  }

  /** HTTP PUT. */
  put<T>(url: string, body: unknown, options: ApiOptions = {}): Promise<T> {
    return this.request<T>('PUT', url, { ...options, body });
  }
}
