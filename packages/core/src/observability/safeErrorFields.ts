/**
 * Log-safe identifying fields of an error: its `code`, `name` and `syscall`,
 * never its message. Database and network error messages can contain the
 * host, port, user or database name, so only these short identifiers are kept
 * (for Postgres the SQLSTATE such as `28P01`, or a Node code such as
 * `ECONNREFUSED` with the failing `syscall`).
 */
export interface SafeErrorFields {
  errorCode?: string | number;
  errorName?: string;
  syscall?: string;
}

export function safeErrorFields(error: unknown): SafeErrorFields {
  const fields: SafeErrorFields = {};
  if (error === null || typeof error !== "object") return fields;
  const { code, name, syscall } = error as { code?: unknown; name?: unknown; syscall?: unknown };
  if (typeof code === "string" || typeof code === "number") fields.errorCode = code;
  if (typeof name === "string") fields.errorName = name;
  if (typeof syscall === "string") fields.syscall = syscall;
  return fields;
}
