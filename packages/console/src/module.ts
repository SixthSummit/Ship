import type {
  AnyChannel,
  AnyOperation,
  AnyOutbox,
  AnyProvider,
  AnyWebhook,
  DependencyToken,
  RealtimePublishBackend,
  UnitOfWorkDependencyToken,
  WebhookEventStore,
} from "@sixthsummit/ship-core";
import { defineModule, defineOperation } from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import { defineConsoleCronOperations } from "./cron.js";
import { InvalidConsoleDefinitionError } from "./errors.js";
import { defineConsoleJobOperations } from "./jobs.js";
import { defineConsoleOutboxOperations } from "./outbox.js";
import { CONSOLE_OPERATE_PERMISSION, consoleAccess } from "./permission.js";
import { defineConsoleRealtimeOperations } from "./realtime.js";
import { type ConsoleWebhookObserver, defineConsoleWebhookOperations } from "./webhooks.js";

const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const BASE_PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/u;

export const DEFAULT_CONSOLE_MODULE_ID = "console";
export const DEFAULT_CONSOLE_BASE_PATH = "/console";

/**
 * A panel contributed from outside this package (the auth-audit panel of
 * 11.2 is the first). Every operation must be namespaced
 * `<consoleId>.<extensionId>.` and gated by exactly the console permission,
 * so an extension can never widen what the console mount exposes.
 */
export interface ConsoleExtension {
  readonly id: string;
  readonly title: string;
  readonly operations: readonly AnyOperation[];
  readonly providers?: readonly AnyProvider[];
}

export interface ConsoleWebhooksPanel {
  readonly webhooks: readonly AnyWebhook[];
  readonly store: DependencyToken<WebhookEventStore>;
  readonly unitOfWork: UnitOfWorkDependencyToken<unknown>;
  readonly observer?: ConsoleWebhookObserver;
}

export interface ConsoleRealtimePanel {
  readonly backend: RealtimePublishBackend;
  readonly channels: readonly AnyChannel[];
}

export interface ConsoleModuleOptions {
  /** Module id and operation id prefix. Defaults to `console`. */
  readonly id?: string;
  /** HTTP path every console route is mounted under. Defaults to `/console`. */
  readonly basePath?: string;
  /**
   * Modules exporting the tokens the panels bind: `jobBackendDependency()`
   * for jobs and cron, each outbox writer for the outbox panel and the
   * webhook store plus unit of work for the webhooks panel.
   */
  readonly imports: readonly string[];
  /** Mount the jobs and cron panels over the application's bound job backend. */
  readonly jobs?: boolean;
  readonly outboxes?: readonly AnyOutbox[];
  readonly webhooks?: ConsoleWebhooksPanel;
  readonly realtime?: ConsoleRealtimePanel;
  readonly extensions?: readonly ConsoleExtension[];
  readonly clock?: () => Date;
}

export interface ConsolePanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly operations: readonly string[];
}

const panelsOutput = z.object({
  id: z.string(),
  basePath: z.string(),
  permission: z.string(),
  panels: z.array(z.object({ id: z.string(), title: z.string(), operations: z.array(z.string()) })),
});

/**
 * Composes the operator console as one ordinary module. Every read and every
 * mutation it mounts is a declared operation gated by `console.operate`, so
 * direct execution, HTTP and the generated client share one access policy
 * and one audit trail.
 */
export function defineConsoleModule(options: ConsoleModuleOptions) {
  assertOptions(options);
  const id = options.id ?? DEFAULT_CONSOLE_MODULE_ID;
  const basePath = options.basePath ?? DEFAULT_CONSOLE_BASE_PATH;
  const clock = options.clock ?? (() => new Date());
  const panel = { prefix: id, basePath, clock };
  const operations: AnyOperation[] = [];
  const providers: AnyProvider[] = [];
  const panels: ConsolePanelDescriptor[] = [];

  const jobs = options.jobs ? defineConsoleJobOperations(panel) : undefined;
  const cron = options.jobs ? defineConsoleCronOperations(panel) : undefined;
  if (jobs && cron) {
    operations.push(...jobs.operations, ...cron.operations);
    panels.push(
      { id: "jobs", title: "Jobs", operations: jobs.operations.map((item) => item.id) },
      { id: "cron", title: "Cron", operations: cron.operations.map((item) => item.id) },
    );
  }

  const webhooks = options.webhooks
    ? defineConsoleWebhookOperations({ ...panel, ...options.webhooks })
    : undefined;
  if (webhooks) {
    operations.push(...webhooks.operations);
    panels.push({
      id: "webhooks",
      title: "Webhooks",
      operations: webhooks.operations.map((item) => item.id),
    });
  }

  const realtime = options.realtime
    ? defineConsoleRealtimeOperations({ ...panel, ...options.realtime })
    : undefined;
  if (realtime) {
    operations.push(...realtime.operations);
    providers.push(...realtime.providers);
    panels.push({
      id: "realtime",
      title: "Realtime",
      operations: realtime.operations.map((item) => item.id),
    });
  }

  const outbox =
    options.outboxes && options.outboxes.length > 0
      ? defineConsoleOutboxOperations({ ...panel, outboxes: options.outboxes })
      : undefined;
  if (outbox) {
    operations.push(...outbox.operations);
    panels.push({
      id: "outbox",
      title: "Outbox",
      operations: outbox.operations.map((item) => item.id),
    });
  }

  for (const extension of options.extensions ?? []) {
    assertExtension(id, extension);
    operations.push(...extension.operations);
    providers.push(...(extension.providers ?? []));
    panels.push({
      id: extension.id,
      title: extension.title,
      operations: extension.operations.map((item) => item.id),
    });
  }

  if (panels.length === 0) {
    throw new InvalidConsoleDefinitionError(
      "SHIP_CONSOLE_PANEL_EMPTY",
      "defineConsoleModule mounts nothing: enable jobs, or pass outboxes, webhooks, realtime or extensions",
    );
  }

  const descriptors = Object.freeze(
    panels.map((item) =>
      Object.freeze({ ...item, operations: Object.freeze([...item.operations]) }),
    ),
  );
  const describe = defineOperation({
    id: `${id}.panels` as const,
    transport: http.get(basePath),
    input: {},
    output: { 200: panelsOutput },
    successStatus: 200,
    errors: [],
    access: consoleAccess(),
    transaction: "none",
    dependencies: {},
    handler: () => ({
      id,
      basePath,
      permission: CONSOLE_OPERATE_PERMISSION,
      panels: descriptors.map((item) => ({ ...item, operations: [...item.operations] })),
    }),
  });

  const module = defineModule({
    id,
    operations: [describe, ...operations],
    providers,
    imports: [...options.imports],
    exports: [],
  });
  return Object.freeze({
    ...module,
    basePath,
    panels: descriptors,
    describe,
    jobs,
    cron,
    webhooks,
    realtime,
    outbox,
  });
}

export type ConsoleModule = ReturnType<typeof defineConsoleModule>;

function assertOptions(options: unknown): asserts options is ConsoleModuleOptions {
  if (typeof options !== "object" || options === null) {
    throw new InvalidConsoleDefinitionError(
      "SHIP_CONSOLE_OPTIONS_INVALID",
      "defineConsoleModule options must be an object",
    );
  }
  const id = Reflect.get(options, "id");
  if (id !== undefined && (typeof id !== "string" || !MODULE_ID_PATTERN.test(id))) {
    throw new InvalidConsoleDefinitionError(
      "SHIP_CONSOLE_ID_INVALID",
      `console module id must be a lowercase dot-separated identifier; received ${JSON.stringify(id)}`,
      { field: "id" },
    );
  }
  const basePath = Reflect.get(options, "basePath");
  if (
    basePath !== undefined &&
    (typeof basePath !== "string" || !BASE_PATH_PATTERN.test(basePath))
  ) {
    throw new InvalidConsoleDefinitionError(
      "SHIP_CONSOLE_OPTIONS_INVALID",
      `console basePath must be an absolute path without a trailing slash; received ${JSON.stringify(basePath)}`,
      { field: "basePath" },
    );
  }
  const imports = Reflect.get(options, "imports");
  if (!Array.isArray(imports) || imports.some((item) => typeof item !== "string")) {
    throw new InvalidConsoleDefinitionError(
      "SHIP_CONSOLE_OPTIONS_INVALID",
      "console imports must list the module ids that export the bound tokens",
      { field: "imports" },
    );
  }
  const clock = Reflect.get(options, "clock");
  if (clock !== undefined && typeof clock !== "function") {
    throw new InvalidConsoleDefinitionError(
      "SHIP_CONSOLE_OPTIONS_INVALID",
      "console clock must be a function",
      { field: "clock" },
    );
  }
}

function assertExtension(
  consoleId: string,
  extension: unknown,
): asserts extension is ConsoleExtension {
  if (
    typeof extension !== "object" ||
    extension === null ||
    typeof Reflect.get(extension, "id") !== "string" ||
    !/^[a-z][a-z0-9-]*$/u.test(Reflect.get(extension, "id") as string) ||
    typeof Reflect.get(extension, "title") !== "string" ||
    !Array.isArray(Reflect.get(extension, "operations"))
  ) {
    throw new InvalidConsoleDefinitionError(
      "SHIP_CONSOLE_EXTENSION_INVALID",
      "console extension must declare a lowercase id, a title and an operations array",
      { field: "extensions" },
    );
  }
  const extensionId = Reflect.get(extension, "id") as string;
  for (const operation of Reflect.get(extension, "operations") as readonly AnyOperation[]) {
    if (!operation.id.startsWith(`${consoleId}.${extensionId}.`)) {
      throw new InvalidConsoleDefinitionError(
        "SHIP_CONSOLE_EXTENSION_OPERATION_ID_INVALID",
        `console extension operation ${JSON.stringify(operation.id)} must start with ${JSON.stringify(`${consoleId}.${extensionId}.`)}`,
        { field: "extensions" },
      );
    }
    const access = operation.access;
    if (
      access.kind !== "permissions" ||
      access.mode !== "all" ||
      !access.permissions.includes(CONSOLE_OPERATE_PERMISSION)
    ) {
      throw new InvalidConsoleDefinitionError(
        "SHIP_CONSOLE_EXTENSION_ACCESS_INVALID",
        `console extension operation ${JSON.stringify(operation.id)} must require ${JSON.stringify(CONSOLE_OPERATE_PERMISSION)} (use consoleAccess())`,
        { field: "extensions" },
      );
    }
  }
}
