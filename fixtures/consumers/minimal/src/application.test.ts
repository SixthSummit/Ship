import { createExecutor, operationActor, type UnitOfWork } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import { createNotesApplication } from "./application.js";
import type { NotesCapabilities } from "./repository.js";

const existing = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Existing note",
  createdAt: new Date("2026-09-04T12:00:00.000Z"),
};
const unitOfWork: UnitOfWork<NotesCapabilities> = {
  kind: "ship.unit-of-work",
  id: "database.notes",
  run: async (_mode, work) =>
    work({
      notes: {
        find: async (id) => (id === existing.id ? existing : undefined),
        create: async (title) => ({ ...existing, title }),
      },
    }),
};

describe("minimal notes application", () => {
  it("enforces permissions before repository work", async () => {
    const result = await createExecutor(createNotesApplication(unitOfWork)).run(
      "notes.read",
      { params: { id: existing.id } },
      { requestId: "unit-denied" },
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: { code: "AUTHENTICATION_ERROR", message: "Authentication required" },
      requestId: "unit-denied",
    });
  });

  it("runs a protected read through the declared unit of work", async () => {
    const result = await createExecutor(createNotesApplication(unitOfWork)).run(
      "notes.read",
      { params: { id: existing.id } },
      {
        requestId: "unit-read",
        actor: operationActor({ id: "unit-user", permissions: ["notes:read"] }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      data: { id: existing.id, title: "Existing note", createdAt: "2026-09-04T12:00:00.000Z" },
    });
  });
});
