import { DrizzleEntityService } from "@sixthsummit/ship-api/app/services/DrizzleEntityService";
import { {{nameCamelPlural}} } from "../schema.js";

/**
 * v4 `{{NameSingular}}Service` — extends `DrizzleEntityService` against the
 * module's `{{namePlural}}` table. Inherits `get` / `getAll` / `list` /
 * `count` / `create` / `update` / `delete` plus soft-delete + audit-column
 * auto-stamping from the base.
 */
export class {{NameSingular}}Service extends DrizzleEntityService<
  typeof {{nameCamelPlural}},
  { {{nameCamelPlural}}: typeof {{nameCamelPlural}} }
> {
  protected getTable() {
    return {{nameCamelPlural}};
  }

  protected override getDefaultSearchFields(): readonly string[] {
    return ["name"];
  }
}
