import { createHttpOperationClient } from "@sixthsummit/ship-contract";
import type { ApplicationContractOf } from "@sixthsummit/ship-contract/application";
import type { UnitOfWork } from "@sixthsummit/ship-core";
import { createNotesApplication } from "./application.js";
import type { NotesCapabilities } from "./repository.js";

declare const unitOfWork: UnitOfWork<NotesCapabilities>;
const application = createNotesApplication(unitOfWork);
const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
  { schemaVersion: 1, appId: "golden-minimal", fingerprint: "sha256:test", operations: [] },
  { baseUrl: "https://golden.example.test" },
);

async function verifyClientContract(): Promise<void> {
  const result = await client.call("notes.create", { body: { title: "Typed note" } });
  if (result.ok) result.data.title satisfies string;

  // @ts-expect-error operation identifiers remain exact in the consumer
  await client.call("notes.remove", { params: { id: "note" } });
  // @ts-expect-error create accepts a body, not path parameters
  await client.call("notes.create", { params: { title: "Wrong location" } });
}

void verifyClientContract;
