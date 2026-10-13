import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveStreamPlatform } from './resolve-stream-platform';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveStreamPlatform', () => {
  it.each([['browser'], ['server']] as const)('honours the explicit %s platform', platform => {
    expect(resolveStreamPlatform(platform)).toBe(platform);
  });

  it('reads PLATFORM_ID when an injection context exists', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: 'server' }],
    });

    expect(TestBed.runInInjectionContext(() => resolveStreamPlatform(undefined))).toBe('server');
  });

  it('falls back to the runtime outside an injection context', () => {
    expect(resolveStreamPlatform(undefined)).toBe('browser');
  });

  it('treats a runtime without a document as a server render', () => {
    vi.stubGlobal('document', undefined);

    expect(resolveStreamPlatform(undefined)).toBe('server');
  });
});
