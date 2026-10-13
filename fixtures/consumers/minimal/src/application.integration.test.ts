import { createHttpOperationClient } from "@sixthsummit/ship-contract";
import type { ApplicationContractOf } from "@sixthsummit/ship-contract/application";
import { projectClientContract } from "@sixthsummit/ship-contract/project";
import { type PostgresTestDb, setupPostgresTestDb } from "@sixthsummit/ship-testing/postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNotesHttpApplication } from "./http.js";
import { createNotesUnitOfWork } from "./repository.js";
import { notesSchema } from "./schema.js";

describe("minimal packed application", () => {
  let database: PostgresTestDb<typeof notesSchema>;

  beforeAll(async () => {
    database = await setupPostgresTestDb(notesSchema);
  });

  afterAll(async () => {
    await database.cleanup();
  });

  it("boots a protected read and transactional write from public packages", async () => {
    const { application, http } = createNotesHttpApplication(createNotesUnitOfWork(database.db));
    const contract = projectClientContract(application);
    const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(contract, {
      baseUrl: "https://golden.example.test",
      headers: { "x-api-key": "golden-test-key" },
      fetch: async (input, init) => http.request(input, init),
    });

    const created = await client.call("notes.create", { body: { title: "Packed note" } });
    expect(created).toMatchObject({ ok: true, status: 201, data: { title: "Packed note" } });
    if (!created.ok) throw new Error("create unexpectedly failed");

    const read = await client.call("notes.read", { params: { id: created.data.id } });
    expect(read).toEqual(expect.objectContaining({ ok: true, status: 200, data: created.data }));

    const denied = await http.request(`/notes/${created.data.id}`);
    expect(denied.status).toBe(401);
  });
});
