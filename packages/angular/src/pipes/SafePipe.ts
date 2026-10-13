import { inject, Pipe, type PipeTransform } from '@angular/core';
import {
  DomSanitizer,
  type SafeHtml,
  type SafeResourceUrl,
  type SafeScript,
  type SafeStyle,
  type SafeUrl,
} from '@angular/platform-browser';

/**
 * Pipe to bypass Angular's built-in sanitization
 *
 * Use with caution! Only use with trusted content.
 *
 * @example
 * ```html
 * <!-- HTML content -->
 * <div [innerHTML]="htmlContent | safe:'html'"></div>
 *
 * <!-- Style content -->
 * <div [style]="styleContent | safe:'style'"></div>
 *
 * <!-- URL content -->
 * <a [href]="urlContent | safe:'url'">Link</a>
 *
 * <!-- Resource URL (iframes, etc.) -->
 * <iframe [src]="iframeSrc | safe:'resourceurl'"></iframe>
 * ```
 */
@Pipe({
  name: 'safe',
  standalone: true,
})
export class SafePipe implements PipeTransform {
  protected readonly sanitizer = inject(DomSanitizer);

  transform(
    value: string,
    type: 'html' | 'style' | 'script' | 'url' | 'resourceurl' = 'html'
  ): SafeHtml | SafeStyle | SafeScript | SafeUrl | SafeResourceUrl {
    const normalizedType = (type || 'html').toLowerCase();

    switch (normalizedType) {
      case 'html':
        return this.sanitizer.bypassSecurityTrustHtml(value);
      case 'style':
        return this.sanitizer.bypassSecurityTrustStyle(value);
      case 'script':
        return this.sanitizer.bypassSecurityTrustScript(value);
      case 'url':
        return this.sanitizer.bypassSecurityTrustUrl(value);
      case 'resourceurl':
        return this.sanitizer.bypassSecurityTrustResourceUrl(value);
      default:
        return this.sanitizer.bypassSecurityTrustHtml(value);
    }
  }
}
