#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { generateContractArtifacts } from "./contract.js";
import { createOperationProject, loadScaffoldReleaseManifest } from "./create.js";
import {
  affectedApplication,
  checkApplication,
  inspectApplication,
  runGraphCommand,
} from "./graph.js";
import { checkRouteMigration } from "./migration.js";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @typedef {{
 *   name?: string,
 *   description?: string,
 *   version?: string,
 *   packageJsonPath?: string,
 *   cwd?: string,
 *   templateDirectory?: string,
 *   releaseManifestPath?: string,
 *   releaseManifest?: import("./create.js").ScaffoldReleaseManifest,
 *   includeCreate?: boolean,
 *   install?: (targetDirectory: string) => void
 * }} CliOptions
 */

/** @param {Command} program @param {CliOptions} [options] */
export function registerApplicationCommands(program, options = {}) {
  if (options.includeCreate !== false) {
    program
      .command("create <project-name>")
      .description("Create a tested operation-native Ship application")
      .option("--current-dir", "Write into the current empty directory")
      .option("--skip-install", "Do not install dependencies")
      .action(async (projectName, commandOptions) => {
        try {
          const releaseManifest =
            options.releaseManifest ??
            (await loadScaffoldReleaseManifest(
              options.releaseManifestPath ?? join(packageDirectory, "lib/release-manifest.json"),
            ));
          const result = await createOperationProject({
            projectName,
            cwd: options.cwd,
            currentDirectory: commandOptions.currentDir,
            skipInstall: commandOptions.skipInstall,
            templateDirectory:
              options.templateDirectory ?? join(packageDirectory, "templates/operation"),
            releaseManifest,
            install: options.install,
          });
          process.stdout.write(
            `${result.packageName} created at ${result.targetDirectory}${
              result.installed ? "" : " (install skipped)"
            }\n`,
          );
        } catch (error) {
          process.stderr.write(
            `ship-api create: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          process.exitCode = 2;
        }
      });
  }

  program
    .command("check")
    .description("Compile and validate the application graph")
    .option("-a, --app <path>", "Application module with a named `app` export", "ship.config.ts")
    .option("--format <format>", "Output format: human or json", "human")
    .option("--emit [path]", "Write the deterministic graph JSON")
    .action(async (options) => {
      process.exitCode = await runGraphCommand(
        () =>
          checkApplication({
            appPath: options.app,
            emit: options.emit === true ? ".ship/graph.json" : options.emit,
          }),
        options,
      );
    });

  program
    .command("inspect <kind> [id]")
    .description("Inspect an app, module, operation, provider, channel, or job graph node")
    .option("-a, --app <path>", "Application module with a named `app` export", "ship.config.ts")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (kind, id, options) => {
      process.exitCode = await runGraphCommand(
        () => inspectApplication(kind, id, { appPath: options.app }),
        options,
      );
    });

  program
    .command("affected <kind> <id>")
    .description("Show graph surfaces affected by a module, operation, provider, channel, or job")
    .option("-a, --app <path>", "Application module with a named `app` export", "ship.config.ts")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (kind, id, options) => {
      process.exitCode = await runGraphCommand(
        () => affectedApplication(kind, id, { appPath: options.app }),
        options,
      );
    });

  program
    .command("contract")
    .description("Emit deterministic client-contract and OpenAPI artifacts")
    .option("-a, --app <path>", "Application module with a named `app` export", "ship.config.ts")
    .option("--out <path>", "Client contract output", ".ship/contract.json")
    .option("--typescript <path>", "Browser-safe TypeScript contract output", ".ship/contract.ts")
    .option("--openapi <path>", "OpenAPI output", ".ship/openapi.json")
    .option("--openapi-title <title>", "OpenAPI document title")
    .option("--api-version <version>", "Advertised API version", "0.0.0")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (options) => {
      process.exitCode = await runGraphCommand(
        () =>
          generateContractArtifacts({
            appPath: options.app,
            out: options.out,
            typescript: options.typescript,
            openapi: options.openapi,
            title: options.openapiTitle,
            version: options.apiVersion,
          }),
        options,
      );
    });

  program
    .command("migrate-routes")
    .description("Check an exactly-once legacy-route to operation mapping")
    .requiredOption("--catalog <path>", "Legacy route catalog JSON")
    .requiredOption("--mapping <path>", "Legacy route disposition JSON")
    .option("-a, --app <path>", "Application module with a named `app` export", "ship.config.ts")
    .option("--format <format>", "Output format: human or json", "human")
    .action(async (options) => {
      process.exitCode = await runGraphCommand(
        () =>
          checkRouteMigration({
            appPath: options.app,
            catalogPath: options.catalog,
            mappingPath: options.mapping,
          }),
        options,
      );
    });

  return program;
}

/**
 * @param {CliOptions} [options]
 * @returns {Command}
 */
export function createCli(options = {}) {
  const packageJson = JSON.parse(
    readFileSync(options.packageJsonPath ?? join(packageDirectory, "package.json"), "utf8"),
  );
  const program = new Command()
    .name(options.name ?? "ship-api")
    .description(options.description ?? "Inspect and project a compiled Ship application")
    .version(options.version ?? packageJson.version);
  return registerApplicationCommands(program, options);
}

/** @param {string[]} [argv] */
export async function runCli(argv = process.argv) {
  await createCli().parseAsync(argv);
}
