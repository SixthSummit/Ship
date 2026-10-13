import { DestroyRef, inject, type Signal, signal } from '@angular/core';
import { Auth } from '@angular/fire/auth';
import type {
  AuthAdapter,
  AuthState,
  AuthUser,
  SignInLinkSettings,
} from '@sixthsummit/ship-angular';
import {
  type AuthProvider,
  createUserWithEmailAndPassword,
  isSignInWithEmailLink as firebaseIsSignInWithEmailLink,
  sendSignInLinkToEmail as firebaseSendSignInLinkToEmail,
  signInWithEmailLink as firebaseSignInWithEmailLink,
  signInWithPopup as firebaseSignInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  type Unsubscribe,
  type User,
} from 'firebase/auth';

/** Firebase implementation of ShipAngular's capability-based frontend auth boundary. */
export class FirebaseAuthAdapter implements AuthAdapter {
  private readonly auth = inject(Auth);
  private readonly internal = signal<AuthState>({ status: 'unknown' });
  private initialization?: Promise<void>;
  private stopAuth: Unsubscribe | undefined;
  private stopToken: Unsubscribe | undefined;
  private destroyed = false;
  private stateRevision = 0;
  private sessionGeneration = 0;
  private observedUser: User | null | undefined;

  readonly state: Signal<AuthState> = this.internal.asReadonly();
  readonly capabilities = {
    password: {
      signIn: (email: string, password: string) => this.signIn(email, password),
      register: (email: string, password: string) => this.register(email, password),
    },
    signOut: { signOut: () => this.signOut() },
    bearerToken: { getToken: (forceRefresh?: boolean) => this.getIdToken(forceRefresh) },
    emailLink: {
      send: (email: string, settings: SignInLinkSettings) =>
        this.sendSignInLinkToEmail(email, settings),
      complete: (email: string, url: string) => this.signInWithEmailLink(email, url),
      recognizes: (url: string) => this.isSignInWithEmailLink(url),
    },
    popup: { signIn: (provider: unknown) => this.signInWithPopup(provider) },
  };

  constructor() {
    inject(DestroyRef).onDestroy(() => this.destroy());
  }

  /** Register provider listeners explicitly and resolve after the first identity event. */
  readonly initialize = (signal?: AbortSignal): Promise<void> => {
    if (this.destroyed) return Promise.reject(new Error('FirebaseAuthAdapter is destroyed'));
    this.initialization ??= this.startListeners();
    return waitForInitialization(this.initialization, signal);
  };

  readonly destroy = (): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopAuth?.();
    this.stopToken?.();
    this.stopAuth = undefined;
    this.stopToken = undefined;
  };

  private startListeners(): Promise<void> {
    return new Promise(resolve => {
      let initialSettled = false;
      const settleInitial = (): void => {
        if (initialSettled) return;
        initialSettled = true;
        resolve();
      };
      const apply = (user: User | null, message: string): void => {
        void this.applyUser(user, message).then(applied => {
          if (applied) settleInitial();
        });
      };
      const failed = (message: string): void => {
        this.setProviderIssue(message);
        settleInitial();
      };
      this.stopAuth = onAuthStateChanged(
        this.auth,
        user => apply(user, 'Firebase identity token could not be read'),
        () => failed('Firebase authentication state could not be established')
      );
      this.stopToken = onIdTokenChanged(
        this.auth,
        user => apply(user, 'Firebase identity token could not be refreshed'),
        () => failed('Firebase token state could not be refreshed')
      );
    });
  }

  private async applyUser(user: User | null, message: string): Promise<boolean> {
    if (this.destroyed || this.auth.currentUser !== user) return false;
    this.observeUser(user);
    // Both listeners can arrive before either token read resolves, in either order.
    const revision = ++this.stateRevision;
    if (user === null) {
      this.internal.set({ status: 'unauthenticated' });
      return true;
    }
    try {
      const idToken = await user.getIdToken();
      if (!this.isCurrentState(user, revision)) return false;
      this.internal.set({ status: 'authenticated', user: toAuthUser(user), idToken });
    } catch {
      if (!this.isCurrentState(user, revision)) return false;
      this.setProviderIssue(message);
    }
    return true;
  }

  private observeUser(user: User | null): void {
    if (user === this.observedUser) return;
    this.observedUser = user;
    this.sessionGeneration++;
  }

  private isCurrentState(user: User, revision: number): boolean {
    return !this.destroyed && this.auth.currentUser === user && this.stateRevision === revision;
  }

  private setProviderIssue(message: string): void {
    if (this.destroyed) return;
    this.stateRevision++;
    const current = this.internal();
    const previousUser = current.status === 'authenticated' ? current.user : undefined;
    this.internal.set({
      status: 'indeterminate',
      issue: { kind: 'provider', message, retryable: true },
      ...(previousUser === undefined ? {} : { previousUser }),
    });
  }

  private async signIn(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(this.auth, email, password);
  }

  private async register(email: string, password: string): Promise<void> {
    await createUserWithEmailAndPassword(this.auth, email, password);
  }

  private async signOut(): Promise<void> {
    await firebaseSignOut(this.auth);
  }

  private async getIdToken(forceRefresh = false): Promise<string | null> {
    const user = this.auth.currentUser;
    if (this.destroyed || user === null) return null;
    this.observeUser(user);
    const generation = this.sessionGeneration;
    const isCurrent = (): boolean =>
      !this.destroyed && this.auth.currentUser === user && this.sessionGeneration === generation;
    try {
      const token = await user.getIdToken(forceRefresh);
      return isCurrent() ? token : null;
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    }
  }

  private async sendSignInLinkToEmail(email: string, settings: SignInLinkSettings): Promise<void> {
    await firebaseSendSignInLinkToEmail(this.auth, email, settings);
  }

  private async signInWithEmailLink(email: string, url: string): Promise<void> {
    await firebaseSignInWithEmailLink(this.auth, email, url);
  }

  private isSignInWithEmailLink(url: string): boolean {
    return firebaseIsSignInWithEmailLink(this.auth, url);
  }

  private async signInWithPopup(provider: unknown): Promise<void> {
    await firebaseSignInWithPopup(this.auth, provider as AuthProvider);
  }
}

function waitForInitialization(initialization: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return initialization;
  if (signal.aborted)
    return Promise.reject(new DOMException('Authentication aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new DOMException('Authentication aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void initialization.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function toAuthUser(firebaseUser: User): AuthUser {
  return {
    uid: firebaseUser.uid,
    email: firebaseUser.email,
    displayName: firebaseUser.displayName,
    photoURL: firebaseUser.photoURL,
  };
}
