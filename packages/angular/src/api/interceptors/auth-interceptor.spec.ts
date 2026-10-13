import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAuthAdapter } from '../../../testing/src/mock-auth-adapter';
import { AuthService } from '../../auth/services/AuthService';
import { API_ORIGINS, authInterceptor } from './auth-interceptor';

describe('authInterceptor', () => {
  let http: HttpClient;
  let httpController: HttpTestingController;
  let auth: AuthService;

  function configure(allowedOrigins: readonly string[] = []): void {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: API_ORIGINS, useValue: allowedOrigins },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpController = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  }

  afterEach(() => {
    if (httpController) httpController.verify();
  });

  it('does not attach a token when no adapter is configured', async () => {
    configure();
    const promise = firstValueFrom(http.get('/api/users'));
    const req = httpController.expectOne('/api/users');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    await promise;
  });

  it('attaches the bearer token to relative URLs when authenticated', async () => {
    configure();
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));
    // Wait a microtask for the adapter to flush its initial state.
    await Promise.resolve();
    await Promise.resolve();

    const promise = firstValueFrom(http.get('/api/users'));
    const req = httpController.expectOne('/api/users');
    expect(req.request.headers.get('Authorization')).toBe('Bearer mock-token');
    expect(req.request.withCredentials).toBe(true);
    req.flush({});
    await promise;
  });

  it('does NOT attach the token to cross-origin URLs by default', async () => {
    configure();
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));
    await Promise.resolve();
    await Promise.resolve();

    const promise = firstValueFrom(http.get('https://api.third-party.test/data'));
    const req = httpController.expectOne('https://api.third-party.test/data');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    await promise;
  });

  it('attaches the token to allowed cross-origin URLs', async () => {
    configure(['https://api.example.test']);
    auth.setAdapter(new MockAuthAdapter({ initialStatus: 'authenticated' }));
    await Promise.resolve();
    await Promise.resolve();

    const promise = firstValueFrom(http.get('https://api.example.test/users'));
    const req = httpController.expectOne('https://api.example.test/users');
    expect(req.request.headers.get('Authorization')).toBe('Bearer mock-token');
    req.flush({});
    await promise;
  });

  it('does not attach when authenticated state has a null idToken', async () => {
    configure();
    const adapter = new MockAuthAdapter();
    auth.setAdapter(adapter);
    adapter.__test.transitionToAuthenticated(
      { uid: 'u1', email: 'a@b.test', displayName: null, photoURL: null },
      null
    );

    const promise = firstValueFrom(http.get('/api/users'));
    const req = httpController.expectOne('/api/users');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({});
    await promise;
  });
});
