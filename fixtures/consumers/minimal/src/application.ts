import { contractSchema } from "@sixthsummit/ship-contract/schema";
import {
  defineApp,
  defineModule,
  defineOperation,
  operationError,
  operationFailure,
  permission,
  type UnitOfWork,
  unitOfWorkDependency,
  valueProvider,
} from "@sixthsummit/ship-core";
import { http } from "@sixthsummit/ship-hono";
import { z } from "zod";
import type { NotesCapabilities } from "./repository.js";
import type { Note } from "./schema.js";

const noteSchema = contractSchema(
  z.object({
    id: z.string().uuid(),
    title: z.string(),
    createdAt: z.coerce.date().transform((value) => value.toISOString()),
  }),
  {
    jsonSchema: {
      type: "object",
      required: ["id", "title", "createdAt"],
      properties: {
        id: { type: "string", format: "uuid" },
        title: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
      },
    },
  },
);
const noteParamsSchema = contractSchema(z.object({ id: z.string().uuid() }), {
  jsonSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
  },
});
const createNoteSchema = contractSchema(z.object({ title: z.string().trim().min(1).max(120) }), {
  jsonSchema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
  },
});
const missingDetailsSchema = contractSchema(z.object({ id: z.string().uuid() }), {
  jsonSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", format: "uuid" } },
  },
});
const noteNotFound = operationError({
  code: "NOTE_NOT_FOUND",
  status: 404,
  message: "Note not found",
  details: missingDetailsSchema,
});

const notesUnitOfWork = unitOfWorkDependency<NotesCapabilities>("database.notes");

function toNoteView(note: Note) {
  return { id: note.id, title: note.title, createdAt: note.createdAt.toISOString() };
}

export function createNotesApplication(unitOfWork: UnitOfWork<NotesCapabilities>) {
  const read = defineOperation({
    id: "notes.read",
    transport: http.get("/notes/:id"),
    input: { params: noteParamsSchema },
    output: { 200: noteSchema },
    successStatus: 200,
    errors: [noteNotFound],
    access: permission("notes:read"),
    transaction: "read",
    dependencies: { tx: notesUnitOfWork },
    handler: async ({ input, services }) => {
      const note = await services.tx.notes.find(input.params.id);
      if (!note) throw operationFailure(noteNotFound, { details: { id: input.params.id } });
      return toNoteView(note);
    },
  });
  const create = defineOperation({
    id: "notes.create",
    transport: http.post("/notes"),
    input: { body: createNoteSchema },
    output: { 201: noteSchema },
    successStatus: 201,
    errors: [],
    access: permission("notes:write"),
    transaction: "write",
    dependencies: { tx: notesUnitOfWork },
    handler: async ({ input, services }) =>
      toNoteView(await services.tx.notes.create(input.body.title)),
  });
  const notesModule = defineModule({
    id: "notes",
    operations: [read, create],
    providers: [valueProvider(notesUnitOfWork, unitOfWork)],
    imports: [],
    exports: [],
  });
  return defineApp({ id: "golden-minimal", modules: [notesModule] });
}
