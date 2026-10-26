import type { ConsoleTrigger } from './console-views';

/** Short, locale-independent rendering of an ISO instant for a table cell. */
export function formatInstant(value: string | undefined): string {
  if (!value) return '—';
  const time = Date.parse(value);
  if (Number.isNaN(time)) return value;
  return new Date(time).toISOString().replace('T', ' ').slice(0, 19);
}

export function formatTrigger(trigger: ConsoleTrigger | undefined): string {
  if (!trigger) return '—';
  switch (trigger.kind) {
    case 'schedule':
      return `${trigger.cron ?? ''} (${trigger.tz ?? 'UTC'})`;
    case 'interval':
      return `every ${trigger.everyMs ?? 0} ms`;
    default:
      return trigger.kind;
  }
}

/** Bounded JSON preview for payload cells. */
export function formatJson(value: unknown, limit = 160): string {
  if (value === undefined) return '—';
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
