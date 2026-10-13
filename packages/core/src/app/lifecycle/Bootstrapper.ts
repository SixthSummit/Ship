/**
 * v4 `Bootstrapper` contract — formalizes the order in which app-init steps
 * run. Replaces v3's "ordered array of `BootstrapperImplementation`s"
 * pattern with a priority-and-dependsOn graph that the framework validates
 * at boot.
 *
 * Each bootstrapper declares:
 *   - `name`: stable identifier (referenced by other bootstrappers' `dependsOn`)
 *   - `priority`: numeric — lower runs first; ties resolve by registration order
 *   - `dependsOn?`: optional list of bootstrapper names that MUST run earlier
 *   - `init(ctx)`: the actual work; receives a context object the framework supplies
 *
 * The plan's standard priorities (documented in the modernization plan):
 *
 * | Priority | Bootstrapper       | Notes                                      |
 * |---------:|--------------------|---------------------------------------------|
 * |        0 | InitObservability  | OTel SDK shutdown registration              |
 * |       10 | InitFirebaseApp    | Firebase Admin SDK init                     |
 * |       20 | InitDatabase       | Drizzle pool + db:migrate                   |
 * |       30 | InitRedis          | Redis connection + readiness                |
 * |       40 | InitMetricsServer  | Prometheus port                             |
 * |       50 | InitModules        | Route registration                          |
 * |       60 | InitJobs           | Needs Redis + Modules                       |
 * |       65 | InitCron           | Needs Jobs (BullMQ repeatable)              |
 * |       85 | InitDevRoutes      | `/dev/routes` HTML view; gated by env       |
 * |       90 | InitCustomRoutes   | Downstream override hook                    |
 * |      100 | InitCustomData     | Last; seeds + custom init                   |
 *
 * Health routes are not a bootstrapper: `createApp()` mounts `/livez` and
 * `/readyz` itself, and `createDb()` registers the `db.primary` check.
 *
 * Validation runs at boot. Misordered configs (a bootstrapper with
 * `dependsOn: ["X"]` where X has higher priority, or X doesn't exist)
 * throw at startup, not at first request — fail loudly, fail early.
 */

export interface BootstrapperContext {
  /**
   * Free-form bag the framework / consumers populate during boot. Each
   * bootstrapper can read what earlier bootstrappers wrote and write its
   * own outputs. Typed as `Record<string, unknown>` so the framework
   * stays agnostic of which keys consumers add.
   *
   * Convention: each bootstrapper writes under a single key matching its
   * function (e.g. InitDatabase writes `ctx.db`, InitRedis writes
   * `ctx.redis`). The eventual App.ts narrows this to a typed view.
   */
  [key: string]: unknown;
}

export interface Bootstrapper {
  /** Stable name. Unique within a single boot. */
  readonly name: string;
  /** Lower priority runs first; ties resolve by registration order. */
  readonly priority: number;
  /** Names of bootstrappers that MUST run earlier. Validated at boot. */
  readonly dependsOn?: readonly string[];
  /** Run the init step. Throw to abort boot. */
  init(ctx: BootstrapperContext): Promise<void> | void;
}

export class BootstrapperOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapperOrderingError";
  }
}

/**
 * Validate the registration order:
 *   - No duplicate names
 *   - Every `dependsOn` reference resolves to a registered bootstrapper
 *   - Every `dependsOn` reference has strictly lower priority (ties not allowed —
 *     a bootstrapper depending on a same-priority peer is ambiguous)
 *
 * Throws `BootstrapperOrderingError` on the first violation.
 */
export function validateBootstrappers(bootstrappers: readonly Bootstrapper[]): void {
  const byName = new Map<string, Bootstrapper>();
  for (const b of bootstrappers) {
    if (byName.has(b.name)) {
      throw new BootstrapperOrderingError(`Duplicate bootstrapper name: "${b.name}"`);
    }
    byName.set(b.name, b);
  }

  for (const b of bootstrappers) {
    for (const dep of b.dependsOn ?? []) {
      const target = byName.get(dep);
      if (!target) {
        throw new BootstrapperOrderingError(
          `Bootstrapper "${b.name}" depends on "${dep}", which is not registered`,
        );
      }
      if (target.priority >= b.priority) {
        throw new BootstrapperOrderingError(
          `Bootstrapper "${b.name}" (priority ${b.priority}) depends on "${target.name}" ` +
            `(priority ${target.priority}); dependencies must run strictly earlier`,
        );
      }
    }
  }
}

/**
 * Sort bootstrappers by `priority` ascending, with ties resolved by
 * original registration order (stable sort — `Array.prototype.sort` is
 * stable in modern JS engines / TC39 spec).
 */
export function sortBootstrappers(bootstrappers: readonly Bootstrapper[]): Bootstrapper[] {
  // Pair with index so we can be explicit about tie-breaking even if the
  // engine's sort weren't stable.
  return bootstrappers
    .map((b, i) => ({ b, i }))
    .sort((a, b) => a.b.priority - b.b.priority || a.i - b.i)
    .map((p) => p.b);
}

export interface RunBootstrappersOptions {
  /** Initial context. Bootstrappers mutate it as they run. */
  context?: BootstrapperContext;
  /**
   * Skip the validation pass — useful only when the caller has already
   * validated (e.g., during hot reload). Default false.
   */
  skipValidation?: boolean;
}

/**
 * Validate (unless skipped), sort, and run each bootstrapper sequentially.
 * Returns the populated context. Throws on the first failed `init`.
 */
export async function runBootstrappers(
  bootstrappers: readonly Bootstrapper[],
  opts: RunBootstrappersOptions = {},
): Promise<BootstrapperContext> {
  if (!opts.skipValidation) validateBootstrappers(bootstrappers);
  const ordered = sortBootstrappers(bootstrappers);
  const ctx: BootstrapperContext = opts.context ?? {};
  for (const b of ordered) {
    await b.init(ctx);
  }
  return ctx;
}
