/**
 * Splits a PostgreSQL migration file into individual statements.
 *
 * The splitter understands single-quoted strings, double-quoted identifiers,
 * `--` line comments, block comments, and dollar-quoted bodies (`$$ ... $$`,
 * `$tag$ ... $tag$`), so a semicolon inside any of those never ends a
 * statement. Drizzle's `--> statement-breakpoint` marker is a line comment,
 * so it needs no special handling.
 */
export interface SqlStatement {
  /** Zero-based position of the statement in the file. */
  readonly index: number;
  /** One-based line on which the first code token appears. */
  readonly line: number;
  /** Statement text with comments removed and whitespace collapsed. */
  readonly code: string;
  /** Raw statement text as written, trimmed. */
  readonly raw: string;
  /** Comment lines (without the leading `--`) that directly precede the statement. */
  readonly leadingComments: readonly string[];
}

export function splitSqlStatements(sql: string): readonly SqlStatement[] {
  const statements: SqlStatement[] = [];
  let code = "";
  let raw = "";
  let leadingComments: string[] = [];
  let pendingComments: string[] = [];
  let statementLine = 0;
  let line = 1;
  let index = 0;
  let position = 0;

  const flush = (): void => {
    const collapsed = code.replace(/\s+/gu, " ").trim();
    if (collapsed.length > 0) {
      statements.push({
        index,
        line: statementLine,
        code: collapsed,
        raw: raw.trim(),
        leadingComments,
      });
      index += 1;
    }
    code = "";
    raw = "";
    leadingComments = [];
    statementLine = 0;
  };

  const startToken = (): void => {
    if (code.trim().length === 0) {
      statementLine = line;
      leadingComments = pendingComments;
      pendingComments = [];
    }
  };

  while (position < sql.length) {
    const character = sql[position] as string;
    const next = sql[position + 1];

    if (character === "-" && next === "-") {
      const end = sql.indexOf("\n", position);
      const stop = end === -1 ? sql.length : end;
      const comment = sql.slice(position + 2, stop).trim();
      pendingComments.push(comment);
      raw += sql.slice(position, stop);
      position = stop;
      continue;
    }

    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", position + 2);
      const stop = end === -1 ? sql.length : end + 2;
      const segment = sql.slice(position, stop);
      line += countLines(segment);
      raw += segment;
      position = stop;
      continue;
    }

    if (character === "'" || character === '"') {
      startToken();
      const stop = findQuoteEnd(sql, position, character);
      const segment = sql.slice(position, stop);
      line += countLines(segment);
      code += segment;
      raw += segment;
      position = stop;
      continue;
    }

    if (character === "$") {
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/u.exec(sql.slice(position));
      if (tag) {
        startToken();
        const opener = tag[0];
        const end = sql.indexOf(opener, position + opener.length);
        const stop = end === -1 ? sql.length : end + opener.length;
        const segment = sql.slice(position, stop);
        line += countLines(segment);
        code += segment;
        raw += segment;
        position = stop;
        continue;
      }
    }

    if (character === ";") {
      raw += character;
      position += 1;
      flush();
      continue;
    }

    if (character === "\n") {
      line += 1;
      code += character;
      raw += character;
      position += 1;
      continue;
    }

    if (!/\s/u.test(character)) startToken();
    code += character;
    raw += character;
    position += 1;
  }

  flush();
  return statements;
}

function findQuoteEnd(sql: string, start: number, quote: string): number {
  let position = start + 1;
  while (position < sql.length) {
    if (sql[position] === quote) {
      if (sql[position + 1] === quote) {
        position += 2;
        continue;
      }
      return position + 1;
    }
    position += 1;
  }
  return sql.length;
}

function countLines(segment: string): number {
  let count = 0;
  for (const character of segment) if (character === "\n") count += 1;
  return count;
}
