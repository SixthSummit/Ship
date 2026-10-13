// Synthetic permission-decorator inputs for migration diagnostics.
import HasPermission from "@sixthsummit/ship-api/app/decorators/HasPermission";

export class SampleController {
  @HasPermission("samples:create") async create() {}
  @HasPermission("samples:read") async get() {}
  @HasPermission("samples:read") async list() {}
  @HasPermission("samples:update") async update() {}
  @HasPermission("samples:delete") async delete() {}
  @HasPermission() async health() {}
}
