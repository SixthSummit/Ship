/** Type-level CI contract for compiled application lookup maps. */
import { z } from "zod";
import { publicAccess } from "./access.js";
import { defineApp } from "./application.js";
import { dependency } from "./dependency.js";
import { defineModule } from "./module.js";
import { defineOperation } from "./operation.js";
import { valueProvider } from "./provider.js";

const clockToken = dependency<{ now(): Date }>("platform.clock");
const clockProvider = valueProvider(clockToken, { now: () => new Date() });
const operation = defineOperation({
  id: "health.read",
  input: {},
  output: { 200: z.object({ status: z.literal("ok") }) },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: { clock: clockToken },
  handler: () => ({ status: "ok" as const }),
});
const module = defineModule({
  id: "health",
  operations: [operation],
  providers: [clockProvider],
  imports: [],
  exports: [clockToken],
});
const app = defineApp({ id: "health-api", modules: [module] });

type Assert<TValue extends true> = TValue;
type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

type _appIdIsLiteral = Assert<Equal<typeof app.id, "health-api">>;
type _moduleLookupIsTyped = Assert<Equal<(typeof app.moduleById)["health"]["id"], "health">>;
type _operationLookupIsTyped = Assert<
  Equal<(typeof app.operationById)["health.read"]["id"], "health.read">
>;
type _operationKeysAreExact = Assert<Equal<keyof typeof app.operationById, "health.read">>;
type _graphVersionIsLiteral = Assert<Equal<typeof app.graph.schemaVersion, 1>>;
