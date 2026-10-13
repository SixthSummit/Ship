import { defineApp, defineModule } from "@sixthsummit/ship-core";

const duplicate = defineModule({
  id: "duplicate",
  operations: [],
  providers: [],
  imports: [],
  exports: [],
});

export const app = defineApp({ id: "invalid-graph-fixture", modules: [duplicate, duplicate] });
