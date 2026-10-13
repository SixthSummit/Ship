import type { JobIntervalTrigger, JobScheduleTrigger } from "@sixthsummit/ship-core";

/**
 * The first occurrence strictly after `from` for an interval or cron trigger.
 * Mirrors `nextOccurrence` in `@sixthsummit/ship-testing/jobs`; the two are
 * kept identical by a parity test so the PostgreSQL backend and the in-memory
 * backend agree on every tick.
 */
export function nextOccurrence(trigger: JobScheduleTrigger | JobIntervalTrigger, from: Date): Date {
  if (trigger.kind === "interval") return new Date(from.getTime() + trigger.everyMs);
  const fields = parseCron(trigger.cron);
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const limit = start + 366 * 24 * 60 * 60_000;
  let candidate = start;
  while (candidate < limit) {
    const parts = localParts(new Date(candidate), trigger.tz);
    const toNextHour = (60 - parts.minute) * 60_000;
    if (
      !fields.dayOfMonth.has(parts.day) ||
      !fields.month.has(parts.month) ||
      !fields.dayOfWeek.has(parts.weekday)
    ) {
      candidate += toNextHour;
    } else if (!fields.hour.has(parts.hour)) {
      candidate += toNextHour;
    } else if (!fields.minute.has(parts.minute)) {
      candidate += 60_000;
    } else {
      return new Date(candidate);
    }
  }
  throw new Error(
    `cron expression ${JSON.stringify(trigger.cron)} has no occurrence within a year`,
  );
}

interface CronFields {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/u);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.length === 6 ? parts.slice(1) : parts;
  return {
    minute: parseField(minute as string, 0, 59),
    hour: parseField(hour as string, 0, 23),
    dayOfMonth: parseField(dayOfMonth as string, 1, 31),
    month: parseField(month as string, 1, 12),
    dayOfWeek: new Set([...parseField(dayOfWeek as string, 0, 7)].map((day) => day % 7)),
  };
}

function parseField(field: string, minimum: number, maximum: number): ReadonlySet<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let low = minimum;
    let high = maximum;
    if (range !== "*") {
      const [lowText, highText] = (range as string).split("-");
      low = Number(lowText);
      high = highText === undefined ? (stepText === undefined ? low : maximum) : Number(highText);
    }
    if (!Number.isInteger(low) || !Number.isInteger(high) || !Number.isInteger(step) || step <= 0) {
      throw new Error(`unsupported cron field ${JSON.stringify(field)}`);
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(
  date: Date,
  tz: string,
): { minute: number; hour: number; day: number; month: number; weekday: number } {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
    });
    formatters.set(tz, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24,
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday as string),
  };
}
