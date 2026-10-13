import { DrizzleEntityService } from "@sixthsummit/ship-api/app/services/DrizzleEntityService";
import { accounts } from "../schema.js";

/**
 * v4 `AccountService` — thin extension of `DrizzleEntityService` against
 * the framework's default `accounts` table.
 *
 * Replaces v3's `EntityService<Account>` subclass. Same surface
 * (`get`/`getAll`/`list`/`count`/`create`/`update`/`delete`) inherited
 * from the base; only the entity-specific overrides live here:
 *
 *   - `getTable()` returns the framework's default `accounts` pgTable
 *   - `getDefaultSearchFields()` lists the columns the free-text
 *     `?search=` filter scans (email + displayName, the human-readable
 *     identifiers operators reach for in admin UIs)
 *   - `getDefaultRelations()` declares `role` so `?relations=role`
 *     loads a populated role
 *
 * Soft-delete + audit-column auto-stamping (createdAt / createdBy on
 * insert; updatedAt / updatedBy on update) are inherited from the
 * base — no per-service wiring required.
 *
 * Schema customization: consumers who extend the `accounts` table via
 * `createApp({ schema })` should subclass this service (or replace it
 * entirely) so `getDefaultSearchFields()` reflects any new searchable
 * columns. The `TSchema` generic carries the full composed schema so
 * Drizzle relational queries stay typed end-to-end.
 */
export class AccountService extends DrizzleEntityService<
  typeof accounts,
  { accounts: typeof accounts }
> {
  protected getTable() {
    return accounts;
  }

  protected override getDefaultSearchFields(): readonly string[] {
    return ["email", "displayName"];
  }

  protected override getDefaultRelations(): readonly string[] {
    return ["role"];
  }
}
