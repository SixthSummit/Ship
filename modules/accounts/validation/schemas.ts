import { z } from "zod";

/**
 * v4 validation surface — Zod schemas piped through `validate('json' | ...)`
 * at the route, with `c.req.valid('json')` reading parsed input. The route
 * registry captures these schemas so MCP tools, the typed-client export, and
 * the eventual OpenAPI compat layer all see the same contract.
 *
 * Field shapes mirror this module's `accounts` table (../schema.ts).
 * Consumers who customize the schema via `createApp({ schema })` should also
 * customize these schemas (extend / override) so server-side validation
 * matches the persisted shape.
 */

const FIREBASE_UID_MAX = 128;
const EMAIL_MAX = 320;
const DISPLAY_NAME_MAX = 200;

export const createAccountSchema = z
  .object({
    /**
     * Stable subject identifier from the AuthProvider. Optional at create
     * time so service-side flows (e.g., admin-creates-pending-account)
     * can fill it in later when the user first signs in.
     */
    firebaseUid: z.string().min(1).max(FIREBASE_UID_MAX).optional(),
    email: z.string().email().max(EMAIL_MAX),
    emailVerified: z.boolean().optional(),
    displayName: z.string().min(1).max(DISPLAY_NAME_MAX).optional(),
    isActive: z.boolean().optional(),
    roleId: z.string().uuid().optional(),
  })
  .strict();

export const updateAccountSchema = z
  .object({
    firebaseUid: z.string().min(1).max(FIREBASE_UID_MAX).optional(),
    email: z.string().email().max(EMAIL_MAX).optional(),
    emailVerified: z.boolean().optional(),
    displayName: z.string().min(1).max(DISPLAY_NAME_MAX).optional(),
    isActive: z.boolean().optional(),
    /** `null` clears the role assignment (FK is nullable). */
    roleId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const accountIdParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * `?search=foo&page=1&perPage=20&isActive=true&roleId=...`
 *
 * `coerce.number` lets the client send the values as strings (the only
 * shape `c.req.query()` produces) and still get number-typed values out.
 */
export const listAccountsQuerySchema = z
  .object({
    search: z.string().min(1).optional(),
    isActive: z.enum(["true", "false"]).optional(),
    roleId: z.string().uuid().optional(),
    page: z.coerce.number().int().positive().default(1),
    perPage: z.coerce.number().int().positive().max(100).default(20),
  })
  .strict();

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;
export type AccountIdParam = z.infer<typeof accountIdParamSchema>;
