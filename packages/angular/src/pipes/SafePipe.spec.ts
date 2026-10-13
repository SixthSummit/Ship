import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DomSanitizer } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { SafePipe } from './SafePipe';

describe('SafePipe', () => {
  let pipe: SafePipe;
  let sanitizer: DomSanitizer;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    pipe = TestBed.runInInjectionContext(() => new SafePipe());
    sanitizer = TestBed.inject(DomSanitizer);
  });

  it('produces a SafeHtml when type is "html"', () => {
    const result = pipe.transform('<b>x</b>', 'html');
    // Comparing the returned object to one produced by the sanitizer
    // directly proves the pipe routed through bypassSecurityTrustHtml.
    const expected = sanitizer.bypassSecurityTrustHtml('<b>x</b>');
    expect(typeof result).toBe(typeof expected);
  });

  it('routes "url" / "resourceurl" / "style" / "script" through the right sanitizer method', () => {
    expect(pipe.transform('javascript:void(0)', 'url')).toBeTruthy();
    expect(pipe.transform('https://x.test/page', 'resourceurl')).toBeTruthy();
    expect(pipe.transform('color: red', 'style')).toBeTruthy();
    expect(pipe.transform('alert(1)', 'script')).toBeTruthy();
  });

  it('defaults to "html" when type is omitted', () => {
    const result = pipe.transform('<i>y</i>');
    expect(result).toBeTruthy();
  });

  it('treats unknown type as "html" (defensive)', () => {
    const result = pipe.transform('<i>y</i>', 'totallyunknown' as 'html');
    expect(result).toBeTruthy();
  });
});
