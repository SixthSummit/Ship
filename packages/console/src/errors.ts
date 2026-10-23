import { operationError } from "@sixthsummit/ship-core";
import { z } from "zod";

/** The bound adapter does not implement the optional capability this operation needs. */
export const consoleCapabilityUnavailable = operationError({
  code: "CONSOLE_CAPABILITY_UNAVAILABLE",
  status: 501,
  message: "The bound adapter does not provide this console capability",
  details: z.object({ capability: z.string(), adapter: z.string() }),
});

export const consoleJobNotFound = operationError({
  code: "CONSOLE_JOB_NOT_FOUND",
  status: 404,
  message: "Declared job not found",
});

export const consoleOutboxNotFound = operationError({
  code: "CONSOLE_OUTBOX_NOT_FOUND",
  status: 404,
  message: "Mounted outbox not found",
});

export const consoleScheduleNotFound = operationError({
  code: "CONSOLE_SCHEDULE_NOT_FOUND",
  status: 404,
  message: "The job is not a scheduled or interval job",
});

export const consoleQueueFull = operationError({
  code: "CONSOLE_QUEUE_FULL",
  status: 503,
  message: "The job backend refused the run because the queue is full",
});

export type ConsoleDiagnosticCode =
  | "SHIP_CONSOLE_OPTIONS_INVALID"
  | "SHIP_CONSOLE_ID_INVALID"
  | "SHIP_CONSOLE_PANEL_EMPTY"
  | "SHIP_CONSOLE_EXTENSION_INVALID"
  | "SHIP_CONSOLE_EXTENSION_ACCESS_INVALID"
  | "SHIP_CONSOLE_EXTENSION_OPERATION_ID_INVALID";

export class InvalidConsoleDefinitionError extends Error {
  readonly code: ConsoleDiagnosticCode;
  readonly field?: string;

  constructor(code: ConsoleDiagnosticCode, message: string, options: { field?: string } = {}) {
    super(message);
    this.name = "InvalidConsoleDefinitionError";
    this.code = code;
    this.field = options.field;
  }
}
