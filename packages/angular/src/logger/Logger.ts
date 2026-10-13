/**
 * Simple logger that only outputs in development mode
 *
 * Configure production mode via the `setProduction` method.
 *
 * @example
 * ```typescript
 * // At app initialization
 * Logger.setProduction(environment.production);
 *
 * // Usage
 * Logger.log('Debug message'); // Only shown in development
 * Logger.error('Error occurred', error);
 * Logger.info('Info message');
 * ```
 */
export class Logger {
  private static isProduction = false;

  /**
   * Set whether the app is running in production mode
   * When true, all log output is suppressed
   */
  static setProduction(production: boolean): void {
    Logger.isProduction = production;
  }

  /**
   * Log a message (suppressed in production)
   */
  static log(message?: any, ...optionalParams: any[]): void {
    if (!Logger.isProduction) {
      console.log(message, ...optionalParams);
    }
  }

  /**
   * Log an error (suppressed in production)
   */
  static error(message?: any, ...optionalParams: any[]): void {
    if (!Logger.isProduction) {
      console.error(message, ...optionalParams);
    }
  }

  /**
   * Log info (suppressed in production)
   */
  static info(message?: any, ...optionalParams: any[]): void {
    if (!Logger.isProduction) {
      console.info(message, ...optionalParams);
    }
  }

  /**
   * Log warning (suppressed in production)
   */
  static warn(message?: any, ...optionalParams: any[]): void {
    if (!Logger.isProduction) {
      console.warn(message, ...optionalParams);
    }
  }

  /**
   * Log debug (suppressed in production)
   */
  static debug(message?: any, ...optionalParams: any[]): void {
    if (!Logger.isProduction) {
      console.debug(message, ...optionalParams);
    }
  }
}
