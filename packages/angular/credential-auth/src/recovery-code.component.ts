import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import type { CredentialChallengePassed } from './credential-auth-views';
import { injectCredentialAuth } from './provide-ship-credential-auth';

/**
 * Answers a pending challenge with one of the recovery codes issued at
 * enrolment. Each code works once; the result carries how many remain.
 */
@Component({
  selector: 'ship-recovery-code',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ship-credential-auth' },
  template: `
    <form class="ship-credential-auth__form" (submit)="submit($event)" aria-label="Recovery code">
      <label>
        Recovery code
        <input
          type="text"
          name="code"
          autocomplete="off"
          spellcheck="false"
          placeholder="xxxxx-xxxxx-xxxxx-xxxxx"
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
      <button type="submit" [disabled]="auth.busy() || code().length < 20">Use recovery code</button>
      <button type="button" class="ship-credential-auth__link" (click)="useAuthenticator.emit()">
        Use the authenticator app instead
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
export class ShipRecoveryCodeComponent {
  readonly auth = injectCredentialAuth();
  readonly code = signal('');
  readonly recovered = output<CredentialChallengePassed>();
  readonly useAuthenticator = output<void>();
  readonly expired = output<void>();

  read(event: Event): string {
    return (event.target as HTMLInputElement).value.trim();
  }

  message(code: string): string {
    switch (code) {
      case 'AUTH_RECOVERY_CODE_INVALID':
        return 'That recovery code is not correct or was already used.';
      case 'AUTH_TOKEN_INVALID':
        return 'This sign-in attempt expired; sign in again.';
      case 'AUTH_ACCOUNT_LOCKED':
        return 'Too many attempts; the account is temporarily locked.';
      default:
        return 'Recovery failed.';
    }
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const result = await this.auth.recover(this.code());
    this.code.set('');
    if (result) this.recovered.emit(result);
    else if (this.auth.failure()?.code === 'AUTH_TOKEN_INVALID') this.expired.emit();
  }
}
