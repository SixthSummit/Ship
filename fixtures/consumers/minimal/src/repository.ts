import type { UnitOfWork } from "@sixthsummit/ship-core";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "@sixthsummit/ship-drizzle";
// This file is the consumer-owned data-access boundary; raw operators do not escape it.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type Note, notes, type notesSchema } from "./schema.js";

export interface NotesRepository {
  find(id: string): Promise<Note | undefined>;
  create(title: string): Promise<Note>;
}

export interface NotesCapabilities {
  readonly notes: NotesRepository;
}

export function createNotesUnitOfWork(
  database: NodePgDatabase<typeof notesSchema>,
): UnitOfWork<NotesCapabilities> {
  return createDrizzleUnitOfWork({
    id: "database.notes",
    database,
    create: (transaction) => ({ notes: createNotesRepository(transaction) }),
  });
}

function createNotesRepository(
  transaction: DrizzleTransaction<typeof notesSchema>,
): NotesRepository {
  const repository: NotesRepository = {
    find: async (id: string) => transaction.query.notes.findFirst({ where: eq(notes.id, id) }),
    create: async (title: string) => {
      const [created] = await transaction.insert(notes).values({ title }).returning();
      if (!created) throw new Error("insert did not return a note");
      return created;
    },
  };
  return Object.freeze(repository);
}
