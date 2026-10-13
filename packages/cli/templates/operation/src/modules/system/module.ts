import { defineModule } from "@sixthsummit/ship-core";
import { readHealth } from "./health.operation.js";

export const systemModule = defineModule({
  id: "system",
  operations: [readHealth],
  providers: [],
  imports: [],
  exports: [],
});
