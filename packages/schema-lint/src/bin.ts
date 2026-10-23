#!/usr/bin/env node

import { runSchemaLintCli } from "./cli.js";

process.exitCode = await runSchemaLintCli(process.argv.slice(2));
