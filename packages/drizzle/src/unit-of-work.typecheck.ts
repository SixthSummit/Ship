import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createDrizzleUnitOfWork, type DrizzleTransaction } from "./unit-of-work.js";

type Schema = Record<string, unknown> & {
  readonly marker: unknown;
};

declare const database: NodePgDatabase<Schema>;

class AccountsRepository {
  constructor(readonly transaction: DrizzleTransaction<Schema>) {}

  find(id: string) {
    return { id };
  }
}

const unitOfWork = createDrizzleUnitOfWork({
  id: "database.primary",
  database,
  create: (transaction) => ({
    accounts: new AccountsRepository(transaction),
    audit: { append: (action: string) => action },
  }),
});

unitOfWork.run("write", ({ accounts, audit }) => {
  const account: { id: string } = accounts.find("account-1");
  const action: string = audit.append("accounts.updated");
  return { account, action };
});

unitOfWork.run("read", (services) => {
  // @ts-expect-error the base connection is not a transactional capability
  services.database;
  // @ts-expect-error unknown repositories are not synthesized
  services.payments;
});

// @ts-expect-error the unit of work retains its database privately
unitOfWork.database;
// @ts-expect-error transaction mode is an explicit closed set
unitOfWork.run("snapshot", () => undefined);
