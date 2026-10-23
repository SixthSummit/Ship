import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import type { CredentialSignInResult } from './credential-auth-views';
import { injectCredentialAuth } from './provide-ship-credential-auth';

/**
 * Email + password sign-in. Emits the result so the host routes to the MFA
 * challenge, the enrolment screen or the application; declared failures
 * (wrong password, lockout with its countdown, rate limit, unverified email)
 * render inline from `auth.failure()`.
 */
@Component({
  selector: 'ship-sign-in',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'ship-credential-auth' },
  template: `
    <form class="ship-credential-auth__form" (submit)="submit($event)" aria-label="Sign in">
      <label>
        Email
        <input
          type="email"
          name="email"
          autocomplete="username"
          required
          [value]="email()"
          (input)="email.set(read($event))"
        />
      </label>
      <label>
        Password
        <input
          type="password"
          name="password"
          autocomplete="current-password"
          required
          [value]="password()"
          (input)="password.set(read($event))"
        />
      </label>
      @if (auth.failure(); as failure) {
        <p class="ship-credential-auth__failure" role="alert">
          {{ message(failure.code) }}
          @if (failure.retryAfterSeconds) { Try again in {{ failure.retryAfterSeconds }} s. }
        </p>
      }
      <button type="submit" [disabled]="auth.busy() || !email() || !password()">Sign in</button>
      <button type="button" class="ship-credential-auth__link" (click)="forgotPassword.emit(email())">
        Forgot password?
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
export class ShipSignInComponent {
  readonly auth = injectCredentialAuth();
  readonly email = signal('');
  readonly password = signal('');
  /** The sign-in answer: `signed-in`, `mfa-required` or `mfa-enrolment-required`. */
  readonly signedIn = output<CredentialSignInResult>();
  readonly forgotPassword = output<string>();

  read(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  message(code: string): string {
    switch (code) {
      case 'AUTH_INVALID_CREDENTIALS':
        return 'Email or password is incorrect.';
      case 'AUTH_ACCOUNT_LOCKED':
        return 'Too many attempts; the account is temporarily locked.';
      case 'AUTH_EMAIL_UNVERIFIED':
        return 'Verify your email address before signing in.';
      case 'AUTH_ACCOUNT_DISABLED':
        return 'This account is disabled.';
      case 'AUTH_RATE_LIMITED':
        return 'Too many attempts from this connection.';
      default:
        return 'Sign-in failed.';
    }
  }

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const result = await this.auth.signIn(this.email().trim(), this.password());
    this.password.set('');
    if (result) this.signedIn.emit(result);
  }
}
