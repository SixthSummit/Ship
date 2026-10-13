import { contractSchema } from "@sixthsummit/ship-contract/schema";
import { defineOperation, publicAccess } from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";

const healthOutput = contractSchema(
  z.object({
    ok: z.literal(true),
    service: z.literal("{{PACKAGE_NAME}}"),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["ok", "service"],
      properties: {
        ok: { const: true },
        service: { const: "{{PACKAGE_NAME}}" },
      },
    },
  },
);

export const readHealth = defineOperation({
  id: "system.health",
  transport: http.get("/health"),
  input: {},
  output: { 200: healthOutput },
  successStatus: 200,
  errors: [],
  access: publicAccess(),
  transaction: "none",
  dependencies: {},
  handler: async () => ({ ok: true as const, service: "{{PACKAGE_NAME}}" as const }),
});
