import {
  ChangeDetectionStrategy,
  Component,
  InjectionToken,
  inject,
  type OnInit,
  signal,
} from '@angular/core';
import type { ShipCredentialAuthClient } from './credential-auth-contract';
import type { CredentialAuditEvent, CredentialFailure } from './credential-auth-views';

/** The operation client the audit panel calls (any `OperationClient`), provided by the console host. */
export const SHIP_AUTH_AUDIT_CLIENT = new InjectionToken<ShipCredentialAuthClient>(
  'SHIP_AUTH_AUDIT_CLIENT'
);

/**
 * The console's auth-audit panel over the `console.auth-audit.*` operations:
 * the audit log filtered by email or event, and session revocation, unlock,
 * disable and re-enable for one account. Mount it under the console shell
 * (`{ path: 'auth-audit', component: ShipAuthAuditPanelComponent }`) with
 * `SHIP_AUTH_AUDIT_CLIENT` provided; a 403 without `console.operate` renders
 * inline like every other panel.
 */
@Component({
  selector: 'ship-auth-audit-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="ship-console__panel">
      <header class="ship-console__header">
        <h2>Auth audit</h2>
        <label>
          Email
          <input type="email" [value]="email()" (input)="email.set(read($event))" />
        </label>
        <label>
          Event
          <input type="text" [value]="event()" (input)="event.set(read($event))" placeholder="sign-in" />
        </label>
        <button type="button" (click)="reload()">Refresh</button>
      </header>
      @if (failure(); as failure) {
        <p class="ship-console__failure" role="alert">
          {{ failure.operation }} failed: {{ failure.code }} ({{ failure.status }}) {{ failure.message }}
        </p>
      }
      @if (account(); as account) {
        <p class="ship-console__account">
          {{ account.account.email }} · roles {{ account.account.roles.join(', ') || 'none' }}
          · MFA {{ account.account.mfaEnabled ? 'on' : 'off' }}
          · {{ account.sessions.length }} active session(s)
          @if (account.locked) { · <strong>locked</strong> }
          · {{ account.account.status }}
          <button type="button" (click)="unlock()" [disabled]="!account.locked && account.failedAttempts === 0">Unlock</button>
          <button type="button" (click)="revokeAll()">Revoke all sessions</button>
          @if (account.account.status === 'active') {
            <button type="button" (click)="setStatus('disabled')">Disable</button>
          } @else {
            <button type="button" (click)="setStatus('active')">Enable</button>
          }
        </p>
      }
      <table class="ship-console__table">
        <thead>
          <tr><th>When</th><th>Event</th><th>Outcome</th><th>Account</th><th>IP</th><th>Details</th></tr>
        </thead>
        <tbody>
          @for (entry of events(); track entry.id) {
            <tr [class.ship-console__row--failure]="entry.outcome === 'failure'">
              <td>{{ entry.createdAt }}</td>
              <td>{{ entry.event }}</td>
              <td>{{ entry.outcome }}</td>
              <td>{{ entry.accountId ?? '' }}</td>
              <td>{{ entry.ip ?? '' }}</td>
              <td>{{ details(entry) }}</td>
            </tr>
          } @empty {
            <tr><td colspan="6">No audit events.</td></tr>
          }
        </tbody>
      </table>
    </section>
  `,
  styles: `
    :host { display: block; font: 14px/1.4 system-ui, sans-serif; }
    .ship-console__header { display: flex; gap: 0.75rem; align-items: end; flex-wrap: wrap; }
    .ship-console__table { width: 100%; border-collapse: collapse; }
    .ship-console__table td, .ship-console__table th { padding: 0.25rem 0.5rem; border-bottom: 1px solid #eee; text-align: left; }
    .ship-console__row--failure { color: #a33; }
    .ship-console__failure { padding: 0.5rem; border: 1px solid #c33; color: #c33; }
  `,
})
export class ShipAuthAuditPanelComponent implements OnInit {
  private readonly client = inject(SHIP_AUTH_AUDIT_CLIENT);
  readonly email = signal('');
  readonly event = signal('');
  readonly events = signal<readonly CredentialAuditEvent[]>([]);
  readonly account = signal<AuditAccount | undefined>(undefined);
  readonly failure = signal<CredentialFailure | undefined>(undefined);

  ngOnInit(): void {
    void this.reload();
  }

  read(event: Event): string {
    return (event.target as HTMLInputElement).value.trim();
  }

  details(entry: CredentialAuditEvent): string {
    return entry.details ? JSON.stringify(entry.details) : '';
  }

  async reload(): Promise<void> {
    const query = {
      ...(this.email() ? { email: this.email() } : {}),
      ...(this.event() ? { event: this.event() } : {}),
      limit: 100,
    };
    const events = await this.call<{ events: readonly CredentialAuditEvent[] }>(
      'console.auth-audit.events',
      { query }
    );
    if (events) this.events.set(events.events);
    if (this.email()) {
      const account = await this.call<AuditAccount>('console.auth-audit.account', {
        query: { email: this.email() },
      });
      this.account.set(account);
    } else {
      this.account.set(undefined);
    }
  }

  async unlock(): Promise<void> {
    const account = this.account();
    if (!account) return;
    const ok = await this.call('console.auth-audit.unlock', {
      body: { accountId: account.account.id },
    });
    if (ok) await this.reload();
  }

  async revokeAll(): Promise<void> {
    const account = this.account();
    if (!account) return;
    const ok = await this.call('console.auth-audit.revoke', {
      body: { accountId: account.account.id },
    });
    if (ok) await this.reload();
  }

  async setStatus(status: 'active' | 'disabled'): Promise<void> {
    const account = this.account();
    if (!account) return;
    const ok = await this.call('console.auth-audit.status', {
      body: { accountId: account.account.id, status },
    });
    if (ok) await this.reload();
  }

  private async call<TData>(operation: string, input: unknown): Promise<TData | undefined> {
    const result = await this.client.call(operation, input);
    if (result.ok) {
      this.failure.set(undefined);
      return result.data as TData;
    }
    this.failure.set({
      operation,
      status: result.status,
      code: result.error.code,
      message: result.error.message,
    });
    return undefined;
  }
}

interface AuditAccount {
  readonly account: {
    readonly id: string;
    readonly email: string;
    readonly roles: readonly string[];
    readonly mfaEnabled: boolean;
    readonly status: 'active' | 'disabled';
  };
  readonly locked: boolean;
  readonly failedAttempts: number;
  readonly sessions: readonly unknown[];
}
