import { defineApp } from "@sixthsummit/ship-core";
import { systemModule } from "./modules/system/module.js";

export const app = defineApp({
  id: "{{PACKAGE_NAME}}",
  modules: [systemModule],
});
