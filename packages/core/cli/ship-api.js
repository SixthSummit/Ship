#!/usr/bin/env node

import { registerApplicationCommands } from "@sixthsummit/ship-cli";
import { Command } from "commander";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { addLibrary, addModule, listLibraries, listModules } from "./commands/add.js";
import { createProject } from "./commands/create.js";
import { devCommand } from "./commands/dev.js";
import { doctorCommand } from "./commands/doctor.js";
import { generateCommand } from "./commands/generate.js";
import { updateProject } from "./commands/update.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
const version = packageJson.version;

const program = new Command();

program
  .name("ship-api")
  .description(
    "ShipAPI Framework CLI - Build TypeScript backends on Hono + Drizzle + BullMQ + OpenTelemetry",
  )
  .version(version);

registerApplicationCommands(program, { includeCreate: false });

program
  .command("create <project-name>")
  .description("Create a new ShipAPI project")
  .option("-t, --template <template>", "Project template to use", "default")
  .option("-d, --database <database>", "Database type (postgres, mysql, sqlite)", "postgres")
  .option("--current-dir", "Install in current directory instead of creating new directory")
  .option("--skip-install", "Skip npm install after project creation")
  .option("--skip-git", "Skip git initialization")
  .action(async (projectName, _options) => {
    try {
      await createProject(projectName, _options);
    } catch (error) {
      console.error("Error creating project:", error.message);
      process.exit(1);
    }
  });

program
  .command("add <name>")
  .description("Add a module or library to your ShipAPI project")
  .option("-f, --force", "Overwrite existing module/library")
  .option("-l, --lib", "Add as library instead of module")
  .action(async (name, options) => {
    try {
      if (options.lib) {
        await addLibrary(name, options);
      } else {
        await addModule(name, options);
      }
    } catch (error) {
      console.error("Error:", error.message);
      process.exit(1);
    }
  });

program
  .command("modules")
  .description("List available modules")
  .action(async () => {
    try {
      await listModules();
    } catch (error) {
      console.error("Error listing modules:", error.message);
      process.exit(1);
    }
  });

program
  .command("libraries")
  .description("List available libraries")
  .action(async () => {
    try {
      await listLibraries();
    } catch (error) {
      console.error("Error listing libraries:", error.message);
      process.exit(1);
    }
  });

program
  .command("update")
  .description("Update an existing ShipAPI project to the latest framework version")
  .option("-f, --force", "Force update even if there are conflicts")
  .action(async (_options) => {
    try {
      await updateProject(_options);
    } catch (error) {
      console.error("Error updating project:", error.message);
      process.exit(1);
    }
  });

// `ship-api g <type> [name]` (alias `generate`) — framework component
// generators per plan §C. Subcommands land incrementally: `doctor`
// first (no template dependencies), then module / resource / service /
// schema / middleware / job / test in subsequent commits.
const generate = program
  .command("generate")
  .alias("g")
  .description("Generate framework components and run health checks");

generate
  .command("doctor")
  .description("Run a project health check (env vars, migrations, audit findings)")
  .action(async () => {
    try {
      await doctorCommand();
    } catch (error) {
      console.error("ship-api g doctor failed:", error.message);
      process.exit(1);
    }
  });

generate
  .command("module <name>")
  .description(
    "Scaffold a new v4 module (schema + service + routes + validation + permissions + index barrel)",
  )
  .option("-f, --force", "Overwrite an existing non-empty target directory", false)
  .action(async (name, options) => {
    try {
      await generateCommand("module", name, { force: options.force });
    } catch (error) {
      console.error("ship-api g module failed:", error.message);
      process.exit(1);
    }
  });

generate
  .command("resource <name>")
  .description(
    "Scaffold a CRUD module customized to a field spec (`--fields title:string,body:text,published:boolean?`)",
  )
  .requiredOption(
    "--fields <spec>",
    'Comma-separated field list ("name:type[?]"). Types: string, text, integer, bigint, boolean, timestamp, uuid, json',
  )
  .option("-f, --force", "Overwrite an existing non-empty target directory", false)
  .action(async (name, options) => {
    try {
      await generateCommand("resource", name, {
        fields: options.fields,
        force: options.force,
      });
    } catch (error) {
      console.error("ship-api g resource failed:", error.message);
      process.exit(1);
    }
  });

generate
  .command("middleware <name>")
  .description("Scaffold a Hono middleware skeleton at src/middleware/<name>.ts")
  .option("-f, --force", "Overwrite an existing file", false)
  .action(async (name, options) => {
    try {
      await generateCommand("middleware", name, { force: options.force });
    } catch (error) {
      console.error("ship-api g middleware failed:", error.message);
      process.exit(1);
    }
  });

generate
  .command("service <name>")
  .description(
    "Scaffold a DrizzleEntityService extension in an existing module's services/ directory",
  )
  .requiredOption("-m, --module <module>", "Target module name (e.g. accounts)")
  .option("-f, --force", "Overwrite an existing file", false)
  .action(async (name, options) => {
    try {
      await generateCommand("service", name, {
        module: options.module,
        force: options.force,
      });
    } catch (error) {
      console.error("ship-api g service failed:", error.message);
      process.exit(1);
    }
  });

generate
  .command("schema <name>")
  .description("Scaffold an additional Drizzle pgTable file in a module's schemas/ directory")
  .requiredOption("-m, --module <module>", "Target module name")
  .option("-f, --force", "Overwrite an existing file", false)
  .action(async (name, options) => {
    try {
      await generateCommand("schema", name, {
        module: options.module,
        force: options.force,
      });
    } catch (error) {
      console.error("ship-api g schema failed:", error.message);
      process.exit(1);
    }
  });

generate
  .command("job <name>")
  .description("Scaffold a BullMQ job stub in a module's jobs/ directory")
  .requiredOption("-m, --module <module>", "Target module name")
  .option("-f, --force", "Overwrite an existing file", false)
  .action(async (name, options) => {
    try {
      await generateCommand("job", name, {
        module: options.module,
        force: options.force,
      });
    } catch (error) {
      console.error("ship-api g job failed:", error.message);
      process.exit(1);
    }
  });

// `ship-api migrate-orm <path> [--write]` — codemod CLI for v3 → v4
// ORM migration. Default mode is analyze: lists detected TypeORM
// decorators and classifies each as auto / partial / manual /
// unknown. With `--write`, emits a Drizzle pgTable schema next to
// each entity (e.g., `Account.ts` → `Account.drizzle.ts`) with
// `// TODO[ship-api migrate-orm]:` markers for items requiring
// manual review.
//
// Loaded lazily: migrate-orm.js imports the `typescript` compiler
// API, which is an optional peer (the project being migrated has it
// as a devDependency; a fresh `npx ... create` environment does not).
// A static import here would crash every CLI command when typescript
// isn't resolvable.
program
  .command("migrate-orm")
  .description("Analyze TypeORM entities and (with --write) emit Drizzle schemas alongside them")
  .argument("[path]", "Path to a .ts file or directory tree to analyze / transform", ".")
  .option("--write", "Emit Drizzle pgTable schemas next to each entity (.ts → .drizzle.ts)", false)
  .action(async (target, options) => {
    try {
      let migrateOrmCommand;
      try {
        ({ migrateOrmCommand } = await import("./commands/migrate-orm.js"));
      } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND" && /['"]typescript['"]/.test(error.message)) {
          console.error(
            "ship-api migrate-orm needs the `typescript` package to parse your TypeORM entities.\n" +
              "Run it from the project being migrated (which has typescript as a devDependency),\n" +
              "or install it first: npm install -D typescript",
          );
          process.exit(1);
        }
        throw error;
      }
      await migrateOrmCommand({ path: target, write: options.write });
    } catch (error) {
      console.error("ship-api migrate-orm failed:", error.message);
      process.exit(1);
    }
  });

program
  .command("dev")
  .description(
    "Run the local stack: docker compose up dependencies, tsx watch the app, wait for /livez",
  )
  .option("--bare", "Skip Docker Compose (use already-running services)")
  .option("--reset", "docker compose down -v before starting (drops volumes)")
  .option("-p, --port <port>", "Port to poll for /livez (default: $PORT or 3000)")
  .action(async (options) => {
    try {
      await devCommand(options);
    } catch (error) {
      console.error("ship-api dev failed:", error.message);
      process.exit(1);
    }
  });

program.parse();
