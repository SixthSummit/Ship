import { readFile } from "node:fs/promises";
import { isRuleId, RULE_IDS, type RuleId } from "./rules.js";

/** Minimum justification length; prevents placeholder entries such as "ok". */
export const MIN_JUSTIFICATION_LENGTH = 12;

export interface AllowEntry {
  /** Migration tag, for example `0007_drop_legacy_flag`. */
  readonly migration: string;
  readonly rule: RuleId;
  /** Required, human-written reason the deliberate exception is safe. */
  readonly justification: string;
  /** Where the entry came from: the allowlist file or an inline SQL comment. */
  readonly source: "file" | "inline";
}

export interface Allowlist {
  readonly entries: readonly AllowEntry[];
  /**
   * Migration tag up to and including which findings are suppressed. Used when
   * adopting the linter on a repository with historical migrations; those
   * migrations still feed table state.
   */
  readonly baseline?: string;
}

export class AllowlistError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid allowlist: ${problems.join("; ")}`);
    this.name = "AllowlistError";
    this.problems = problems;
  }
}

export const EMPTY_ALLOWLIST: Allowlist = Object.freeze({ entries: [] });

/**
 * Parses an allowlist document:
 *
 * ```json
 * {
 *   "baseline": "0042_last_historical",
 *   "allow": [
 *     { "migration": "0043_drop_legacy", "rule": "column-drop", "justification": "..." }
 *   ]
 * }
 * ```
 */
export function parseAllowlist(document: unknown): Allowlist {
  const problems: string[] = [];
  if (!isObject(document)) throw new AllowlistError(["document must be an object"]);
  const entries: AllowEntry[] = [];
  let baseline: string | undefined;

  if (document.baseline !== undefined) {
    if (isNonEmptyString(document.baseline)) baseline = document.baseline;
    else problems.push("baseline must be a non-empty migration tag when present");
  }

  const allow = document.allow;
  if (!Array.isArray(allow)) {
    problems.push("allow must be an array");
  } else {
    for (const [index, value] of allow.entries()) {
      const path = `allow[${index}]`;
      if (!isObject(value)) {
        problems.push(`${path} must be an object`);
        continue;
      }
      const entry = readEntry(value, path, problems, "file");
      if (entry) entries.push(entry);
    }
  }

  if (problems.length > 0) throw new AllowlistError(problems);
  return baseline === undefined ? { entries } : { entries, baseline };
}

export async function readAllowlistFile(path: string): Promise<Allowlist> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new AllowlistError([`cannot read ${path}: ${(error as Error).message}`]);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new AllowlistError([`${path} is not valid JSON: ${(error as Error).message}`]);
  }
  return parseAllowlist(document);
}

const INLINE_DIRECTIVE = /^ship-schema-lint:\s*allow\s+([a-z-]+)(?:\s+(.*))?$/iu;

/**
 * Reads inline directives from the comments directly above a statement:
 *
 * ```sql
 * -- ship-schema-lint: allow column-drop readers removed in release 2026.10.1, data archived to s3://...
 * ALTER TABLE "orders" DROP COLUMN "legacy_flag";
 * ```
 */
export function readInlineDirectives(
  migration: string,
  leadingComments: readonly string[],
): { readonly entries: readonly AllowEntry[]; readonly problems: readonly string[] } {
  const entries: AllowEntry[] = [];
  const problems: string[] = [];
  for (const comment of leadingComments) {
    const match = INLINE_DIRECTIVE.exec(comment.trim());
    if (!match) continue;
    const entry = readEntry(
      { migration, rule: match[1], justification: match[2] ?? "" },
      `${migration} inline directive`,
      problems,
      "inline",
    );
    if (entry) entries.push(entry);
  }
  return { entries, problems };
}

function readEntry(
  value: Record<string, unknown>,
  path: string,
  problems: string[],
  source: AllowEntry["source"],
): AllowEntry | undefined {
  let valid = true;
  if (!isNonEmptyString(value.migration)) {
    problems.push(`${path}.migration must be a non-empty migration tag`);
    valid = false;
  }
  if (!isRuleId(value.rule)) {
    problems.push(`${path}.rule must be one of ${RULE_IDS.join(", ")}`);
    valid = false;
  }
  const justification = typeof value.justification === "string" ? value.justification.trim() : "";
  if (justification.length < MIN_JUSTIFICATION_LENGTH) {
    problems.push(
      `${path}.justification is required (at least ${MIN_JUSTIFICATION_LENGTH} characters explaining why the exception is safe)`,
    );
    valid = false;
  }
  if (!valid) return undefined;
  return {
    migration: value.migration as string,
    rule: value.rule as RuleId,
    justification,
    source,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
