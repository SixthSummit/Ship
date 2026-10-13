import { isPlatformBrowser } from '@angular/common';
import {
  computed,
  DestroyRef,
  Injectable,
  inject,
  PLATFORM_ID,
  type Signal,
  signal,
  type WritableSignal,
} from '@angular/core';

/**
 * Configuration for {@link OnlineService} health-check polling.
 */
export interface OnlinePollConfig {
  /**
   * URL to poll. Default: `/healthz` (matches ShipAPI v4's
   * `registerHealthRoutes` mount point).
   */
  url?: string;
  /** Polling interval in milliseconds. Default: `30000` (30s). */
  intervalMs?: number;
  /** Per-request timeout. Default: `5000` (5s). */
  timeoutMs?: number;
  /** Override `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Reactive online/offline state for offline-aware UX.
 *
 * Combines `navigator.onLine` (event-driven) with optional periodic
 * health-check polling against ShipAPI's `/healthz` endpoint. Useful
 * for distinguishing "lost network" from "backend down" in the UX —
 * `navigator.onLine` only flips on explicit OS-level network events,
 * which miss many real-world failure modes.
 *
 * Browser-only: SSR contexts return a constant `online()` of `true` and
 * never poll.
 *
 * @example Basic offline banner
 * ```ts
 * @Component({...})
 * export class App {
 *   readonly online = inject(OnlineService);
 * }
 * // template: @if (!online.online()) { <div>You're offline</div> }
 * ```
 *
 * @example Enable health-check polling against ShipAPI
 * ```ts
 * provideAppInitializer(() => {
 *   const online = inject(OnlineService);
 *   online.startPolling({ url: '/api/healthz', intervalMs: 30_000 });
 * });
 * ```
 */
@Injectable({ providedIn: 'root' })
export class OnlineService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  private readonly navigatorOnline: WritableSignal<boolean> = signal(this.initialNavigatorState());
  private readonly healthOk: WritableSignal<boolean> = signal(true);

  /**
   * Combined online state — `true` when `navigator.onLine` is `true` AND
   * (if polling is enabled) the latest health probe succeeded.
   */
  readonly online: Signal<boolean> = computed(() => this.navigatorOnline() && this.healthOk());

  private pollHandle: ReturnType<typeof setInterval> | undefined;
  private currentPollAbort: AbortController | undefined;

  constructor() {
    if (this.isBrowser) {
      const handleOnline = () => this.navigatorOnline.set(true);
      const handleOffline = () => this.navigatorOnline.set(false);
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
        this.stopPolling();
      });
    }
  }

  /**
   * Start polling a health-check endpoint. Idempotent — calling again
   * stops the previous interval before starting a new one.
   */
  startPolling(config: OnlinePollConfig = {}): void {
    if (!this.isBrowser) return;
    this.stopPolling();
    const url = config.url ?? '/healthz';
    const intervalMs = config.intervalMs ?? 30_000;
    const timeoutMs = config.timeoutMs ?? 5_000;
    const fetchImpl = config.fetch ?? fetch;
    const probe = () => this.runProbe(url, timeoutMs, fetchImpl);
    void probe();
    this.pollHandle = setInterval(probe, intervalMs);
  }

  /** Stop the periodic probe, if any. Safe to call repeatedly. */
  stopPolling(): void {
    if (this.pollHandle !== undefined) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    this.currentPollAbort?.abort();
    this.currentPollAbort = undefined;
  }

  /**
   * Run a single probe immediately. Useful as a "retry" affordance when
   * the user reports the offline-banner is wrong, or as part of an
   * "online again" handler.
   */
  async probe(config: OnlinePollConfig = {}): Promise<void> {
    if (!this.isBrowser) return;
    await this.runProbe(config.url ?? '/healthz', config.timeoutMs ?? 5_000, config.fetch ?? fetch);
  }

  private async runProbe(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<void> {
    this.currentPollAbort?.abort();
    const controller = new AbortController();
    this.currentPollAbort = controller;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      this.healthOk.set(res.ok);
    } catch {
      this.healthOk.set(false);
    } finally {
      clearTimeout(timeoutId);
      if (this.currentPollAbort === controller) this.currentPollAbort = undefined;
    }
  }

  private initialNavigatorState(): boolean {
    if (!this.isBrowser) return true;
    return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
      ? navigator.onLine
      : true;
  }
}
