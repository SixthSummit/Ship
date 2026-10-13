import { Pipe, type PipeTransform } from '@angular/core';

/**
 * Pipe to truncate text with ellipsis
 *
 * @example
 * ```html
 * <!-- Truncate at 25 characters (default) -->
 * {{ longText | truncate }}
 *
 * <!-- Truncate at 50 characters -->
 * {{ longText | truncate:50 }}
 *
 * <!-- Truncate at word boundary -->
 * {{ longText | truncate:50:true }}
 *
 * <!-- Custom ellipsis -->
 * {{ longText | truncate:50:false:' [more]' }}
 * ```
 */
@Pipe({
  name: 'truncate',
  standalone: true,
})
export class TruncatePipe implements PipeTransform {
  /**
   * @param value - The text to truncate
   * @param limit - Maximum character length (default: 25)
   * @param completeWords - If true, truncate at word boundary
   * @param ellipsis - String to append when truncated (default: '...')
   */
  transform(value: string, limit = 25, completeWords = false, ellipsis = '...'): string {
    if (!value) return '';

    if (value.length <= limit) {
      return value;
    }

    let truncateAt = limit;

    if (completeWords) {
      // Find the last space before the limit
      const lastSpace = value.substring(0, limit).lastIndexOf(' ');
      if (lastSpace > 0) {
        truncateAt = lastSpace;
      }
    }

    return value.substring(0, truncateAt) + ellipsis;
  }
}
