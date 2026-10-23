import { createHttpOperationClient } from "@sixthsummit/ship-contract";
import type { ApplicationContractOf } from "@sixthsummit/ship-contract/application";
import { type CustomizedInfrastructure, createCustomizedApplication } from "./application.js";

declare const infrastructure: CustomizedInfrastructure;
const application = createCustomizedApplication(infrastructure);
const client = createHttpOperationClient<ApplicationContractOf<typeof application>>(
  { schemaVersion: 1, appId: "golden-customized", fingerprint: "sha256:test", operations: [] },
  { baseUrl: "https://golden.example.test" },
);

async function verifyClientContract(): Promise<void> {
  const summary = await client.call("portfolio.summary", {
    params: { tenantId: "acme" },
    query: { states: ["open"], minimumEffort: 3, limit: 5 },
  });
  if (summary.ok) summary.data.projects[0]?.totalEffort satisfies number | undefined;

  const notification = await client.call("reports.notify", {
    params: { tenantId: "acme" },
    body: { recipient: "ops@example.test", subject: "Status" },
  });
  if (notification.ok) notification.data.adapter satisfies string;

  const request = await client.call("reports.request", {
    params: { tenantId: "acme" },
    body: { requestKey: "weekly-1", recipient: "ops@example.test", subject: "Status" },
  });
  if (request.ok) request.data.queued satisfies boolean;
  if (!request.ok) {
    // The executor-enforced idempotency failure is part of the typed client result.
    request.error.code satisfies "IDEMPOTENT_IN_FLIGHT" | (string & {});
  }
  const progress = client.call("reports.progress", {
    params: { tenantId: "acme" },
    body: { steps: 3 },
  });
  for await (const frame of progress.frames) frame.percent satisfies number;
  (await progress.terminal)?.steps satisfies number | undefined;
  progress.abort();
  // @ts-expect-error streaming operations return a handle, not a promise
  await progress.then(() => undefined);

  // @ts-expect-error operation identifiers stay exact in a customized consumer
  await client.call("portfolio.export", {});
  // @ts-expect-error inbound webhooks are provider-facing and absent from the client contract
  await client.call("payments.stripe-webhook", {});
  // @ts-expect-error notification input requires a body, not a query payload
  await client.call("reports.notify", { params: { tenantId: "acme" }, query: {} });
}

// Channel payloads are part of the typed contract, derived from the plain Zod declarations.
type Channels = ApplicationContractOf<typeof application>["channels"];
declare const channels: Channels;
channels["reports.delivered"].payload.recipient satisfies string;
channels["portfolio.activity"].presence satisfies true;
channels["portfolio.activity"].payload.itemCount satisfies number;
// @ts-expect-error channel ids stay exact
channels["reports.unknown"];

async function verifyCredentialAuthContract(): Promise<void> {
  const signIn = await client.call("auth.sign-in", {
    body: { email: "ada@example.test", password: "correct horse battery staple" },
  });
  if (signIn.ok) {
    if (signIn.data.status === "signed-in") signIn.data.session.token satisfies string;
    if (signIn.data.status === "mfa-required") signIn.data.challenge.token satisfies string;
    if (signIn.data.status === "mfa-enrolment-required") {
      signIn.data.session.mfaState satisfies "none" | "pending-enrolment" | "verified";
    }
  }
  if (!signIn.ok) {
    signIn.error.code satisfies "AUTH_INVALID_CREDENTIALS" | "AUTH_ACCOUNT_LOCKED" | (string & {});
  }
  const events = await client.call("console.auth-audit.events", { query: { limit: 10 } });
  if (events.ok) events.data.events[0]?.event satisfies string | undefined;
  // @ts-expect-error sign-in requires the password in the body
  await client.call("auth.sign-in", { body: { email: "ada@example.test" } });
}

void verifyClientContract;
void verifyCredentialAuthContract;

// Attachment policies are part of the typed contract, carrying no provider detail.
type Attachments = ApplicationContractOf<typeof application>["attachments"];
declare const attachments: Attachments;
attachments["portfolio.photo"].cardinality satisfies "many";
attachments["portfolio.photo"].visibility satisfies "private";
attachments["portfolio.photo"].variants satisfies "thumb";
// @ts-expect-error attachment ids stay exact
attachments["portfolio.unknown"];

async function verifyStorageContract(): Promise<void> {
  const intent = await client.call("ship-storage.create-intent", {
    body: { attachment: "portfolio.photo", contentType: "image/png", size: 12 },
  });
  if (intent.ok) intent.data.upload.url satisfies string;
  const complete = await client.call("ship-storage.complete", {
    params: { intentId: "intent-1" },
  });
  if (complete.ok) complete.data.objectId satisfies string;
  const photos = await client.call("portfolio.photos", {
    params: { tenantId: "acme", projectId: "project-1" },
  });
  if (photos.ok) photos.data.photos[0]?.thumb satisfies string | null | undefined;
}
void verifyStorageContract;

// Rich text documents travel as the document model; the typed client never sees HTML on the way in.
async function verifyRichTextContract(): Promise<void> {
  const saved = await client.call("portfolio.save-document", {
    params: { tenantId: "acme", documentId: "doc-1" },
    body: {
      title: "Letter",
      document: { schemaVersion: 1, type: "doc", content: [{ type: "paragraph" }] },
    },
  });
  if (saved.ok) saved.data.attached satisfies readonly string[];
  // The declared refusal is part of the typed result next to the framework failures.
  if (!saved.ok) saved.error.code satisfies "DOCUMENT_INVALID" | (string & {});
  const read = await client.call("portfolio.document", {
    params: { tenantId: "acme", documentId: "doc-1" },
  });
  if (read.ok) read.data.html satisfies string;
  await client.call("portfolio.save-document", {
    params: { tenantId: "acme", documentId: "doc-1" },
    // @ts-expect-error the body carries a document model, not an HTML string
    body: { title: "Letter", document: "<p>hi</p>" },
  });
}
void verifyRichTextContract;
