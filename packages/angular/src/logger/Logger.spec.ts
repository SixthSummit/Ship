import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from './Logger';

describe('Logger', () => {
  afterEach(() => {
    Logger.setProduction(false);
    vi.restoreAllMocks();
  });

  it('logs to console in development mode', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    Logger.setProduction(false);
    Logger.log('hello', { extra: true });
    expect(spy).toHaveBeenCalledWith('hello', { extra: true });
  });

  it('suppresses log in production mode', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    Logger.setProduction(true);
    Logger.log('should not show');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['error', 'error'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['debug', 'debug'],
  ] as const)('routes %s to console.%s in dev', (method, consoleMethod) => {
    const spy = vi.spyOn(console, consoleMethod).mockImplementation(() => undefined);
    Logger.setProduction(false);
    (Logger as unknown as Record<string, (...args: unknown[]) => void>)[method]('msg');
    expect(spy).toHaveBeenCalledWith('msg');
  });

  it('suppresses error/info/warn/debug in production', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    Logger.setProduction(true);

    Logger.error('e');
    Logger.info('i');
    Logger.warn('w');
    Logger.debug('d');

    expect(errSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
