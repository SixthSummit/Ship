// Synthetic framework fixture: no application schemas or captured client contracts.
import type { ClientContract, ClientTypeContract } from "./index.js";

export const clientContract = {
  schemaVersion: 1,
  appId: "type-scaling-fixture",
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  operations: [
    {
      id: "records.read01",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "01",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "01",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/01/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write01",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 1,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "01",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "01",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/01/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read02",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "02",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "02",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/02/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write02",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 2,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "02",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "02",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/02/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read03",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "03",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "03",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/03/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write03",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 3,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "03",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "03",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/03/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read04",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "04",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "04",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/04/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write04",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 4,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "04",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "04",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/04/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read05",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "05",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "05",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/05/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write05",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 5,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "05",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "05",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/05/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read06",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "06",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "06",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/06/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write06",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 6,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "06",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "06",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/06/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read07",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "07",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "07",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/07/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write07",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 7,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "07",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "07",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/07/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read08",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "08",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "08",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/08/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write08",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 8,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "08",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "08",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/08/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
    {
      id: "records.read09",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 200,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "09",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "NOT_FOUND",
          status: 404,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "09",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "read",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "GET",
          path: "/records/09/:id",
          response: "json",
        },
      },
      publishes: [],
    },
    {
      id: "records.write09",
      input: {
        params: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        body: {
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              label: {
                type: "string",
              },
              revision: {
                const: 9,
              },
              tags: {
                type: "array",
                items: {
                  type: "string",
                },
              },
            },
            required: ["label", "revision", "tags"],
            additionalProperties: false,
          },
        },
      },
      success: [
        {
          status: 201,
          vendor: "ship",
          jsonSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              variant: {
                const: "09",
              },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    value: {
                      type: "number",
                    },
                    state: {
                      enum: ["new", "ready", "archived"],
                    },
                    note: {
                      anyOf: [
                        {
                          type: "string",
                        },
                        {
                          type: "null",
                        },
                      ],
                    },
                  },
                  required: ["value", "state", "note"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "variant", "items"],
            additionalProperties: false,
          },
        },
      ],
      errors: [
        {
          code: "CONFLICT",
          status: 409,
          message: "Fixture failure",
          details: {
            vendor: "ship",
            jsonSchema: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                variant: {
                  const: "09",
                },
              },
              required: ["id", "variant"],
              additionalProperties: false,
            },
          },
        },
      ],
      access: {
        kind: "authenticated",
      },
      transaction: "write",
      transport: {
        kind: "http",
        binding: "hono",
        metadata: {
          method: "POST",
          path: "/records/09/:id",
          response: "json",
          requestBody: {
            mode: "json",
          },
        },
      },
      publishes: [],
    },
  ],
} as const satisfies ClientContract;

export type AppContract = ClientTypeContract<typeof clientContract>;
