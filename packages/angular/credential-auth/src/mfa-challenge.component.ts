import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import type { CredentialChallengePassed } from './credential-auth-views';
import { injectCredentialAuth } from './provide-ship-credential-auth';

/**
 * The second factor after a `mfa-required` sign-in: a six-digit authenticator
 * code. Offers the recovery-code path and reports an expired challenge so the
 * host returns to the password step.
 */
@Component({
  selector: 'ship-mfa-challenge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ship-credential-auth' },
  template: `
    <form class="ship-credential-auth__form" (submit)="submit($event)" aria-label="Two-factor code">
      <label>
        Authenticator code
        <input
          type="text"
          name="code"
          inputmode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]*"
          maxlength="8"
          required
          [value]="code()"
          (input)="code.set(read($event))"
        />
      </label>
      @if (auth.failure(); as failure) {
        <p class="ship-credential-auth__failure" role="alert">
          {{ message(failure.code) }}
          @if (failure.retryAfterSeconds) { Try again in {{ failure.retryAfterSeconds }} s. }
        </p>
      }
      <button type="submit" [disabled]="auth.busy() || code().length < 6">Verify</button>
      <button type="button" class="ship-credential-auth__link" (click)="useRecoveryCode.emit()">
        Use a recovery code instead
      </button>
    </form>
  `,
  styles: `
    :host { display: block; font: 14px/1.4 system-ui, sans-serif; }
    .ship-credential-auth__form { display: grid; gap: 0.75rem; max-width: 24rem; }
    .ship-credential-auth__form label { display: grid; gap: 0.25rem; }
    .ship-credential-auth__failure { padding: 0.5rem; border: 1px solid #c33; color: #c33; margin: 0; }
    .ship-credential-auth__link { background: none; border: none; color: inherit; text-decoration: underline; cursor: pointer; }
  `,
})
export class ShipMfaChallengeComponent {
  readonly auth = injectCredentialAuth();
  readonly code = signal('');
  readonly verified = output<CredentialChallengePassed>();
  readonly useRecoveryCode = output<void>();
  /** The challenge expired or was consumed; sign in again. */
  readonly expired = output<void>();

  read(event: Event): string {
    return (event.target as HTMLInputElement).value.replace(/\s+/gu, '');
  }

  message(code: string): string {
    switch (code) {
      case 'AUTH_MFA_INVALID_CODE':
        return 'That code is not correct or was already used.';
      case 'AUTH_TOKEN_INVALID':
        return 'This sign-in attempt expired; sign in again.';
      case 'AUTH_ACCOUNT_LOCKED':
        return 'Too many attempts; the account is temporarily locked.';
      case 'AUTH_RATE_LIMITED':
        return 'Too many attempts from this connection.';
      default:
        return 'Verification failed.';
    }
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const result = await this.auth.verifyTotp(this.code());
    this.code.set('');
    if (result) this.verified.emit(result);
    else if (this.auth.failure()?.code === 'AUTH_TOKEN_INVALID') this.expired.emit();
  }
}
