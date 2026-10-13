import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateContractArtifacts } from "../packages/cli/src/contract.js";
import { renderOperationFormBinding } from "../packages/cli/src/forms.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out");
if (outFlag !== -1 && !process.argv[outFlag + 1]) throw new Error("--out requires a directory");
const out = path.resolve(outFlag === -1 ? ".ship/joint" : process.argv[outFlag + 1]);
const require = createRequire(import.meta.url);
const { build } = await import(
  pathToFileURL(createRequire(require.resolve("tsx/package.json")).resolve("esbuild"))
);
await fs.mkdir(out, { recursive: true });
const work = await fs.mkdtemp(path.join(out, ".build-"));
const alias = Object.fromEntries(
  ["kernel", "hono"].map((p) => [
    p === "kernel" ? "@sixthsummit/ship-core" : "@sixthsummit/ship-hono",
    path.join(root, "packages", p, "lib/index.js"),
  ]),
);
try {
  await build({
    entryPoints: [path.join(root, "fixtures/joint-conformance/app.ts")],
    outfile: path.join(work, "app.mjs"),
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    alias,
    logLevel: "silent",
  });
  const generated = await generateContractArtifacts({
    appPath: path.join(work, "app.mjs"),
    cwd: work,
  });
  const contract = JSON.parse(await fs.readFile(generated.contract, "utf8"));
  const dirs = {
    contract: path.join(work, "contract"),
    client: path.join(work, "client"),
    server: path.join(work, "server"),
  };
  for (const dir of Object.values(dirs)) await fs.mkdir(dir);
  const names = {
    contract: "@sixthsummit/ship-api-conformance-contract",
    client: "@sixthsummit/ship-api-conformance-client",
    server: "@sixthsummit/ship-api-conformance-server",
  };
  const metadata = {
    fixtureProtocolVersion: 1,
    graphHash: contract.fingerprint,
    operations: Object.fromEntries(contract.operations.map((o) => [o.id, { transport: "http" }])),
  };
  const forms = renderOperationFormBinding(
    contract,
    "accounts.create",
    { name: "", note: null, enabled: false },
    "accountFormBinding",
  );
  await fs.writeFile(
    path.join(dirs.contract, "index.ts"),
    `export const clientContract=${JSON.stringify(contract)} as const;\nexport const contractMetadata=${JSON.stringify(metadata)} as const;\n${forms}`,
  );
  await build({
    entryPoints: [path.join(dirs.contract, "index.ts")],
    outfile: path.join(dirs.contract, "index.js"),
    bundle: true,
    minify: true,
    platform: "browser",
    format: "esm",
  });
  for (const file of ["manifest.d.ts", "type-contract.d.ts"])
    await fs.copyFile(
      path.join(root, "packages/contract/lib", file),
      path.join(dirs.contract, file),
    );
  await fs.writeFile(
    path.join(dirs.contract, "index.d.ts"),
    `import type {ClientTypeContract} from './type-contract.js';\nexport declare const clientContract: ${JSON.stringify(contract)};\nexport declare const contractMetadata: ${JSON.stringify(metadata)};\nexport type FixtureContract=ClientTypeContract<typeof clientContract>;\n`,
  );
  // tsc emits the form function declarations from generated source, without server imports.
  execFileSync(
    "pnpm",
    [
      "exec",
      "tsc",
      path.join(dirs.contract, "index.ts"),
      "--declaration",
      "--emitDeclarationOnly",
      "--skipLibCheck",
      "--target",
      "ES2022",
      "--module",
      "ES2022",
      "--outDir",
      path.join(work, "types"),
    ],
    { cwd: root, stdio: "pipe" },
  );
  const declarations = await fs.readFile(path.join(work, "types/index.d.ts"), "utf8");
  await fs.appendFile(
    path.join(dirs.contract, "index.d.ts"),
    declarations.slice(declarations.indexOf("export declare const accountFormBinding")),
  );
  await fs.rm(path.join(dirs.contract, "index.ts"));
  await fs.writeFile(
    path.join(dirs.client, "entry.js"),
    `import {createHttpOperationClient} from ${JSON.stringify(path.join(root, "packages/contract/lib/client.js"))};\nimport {clientContract} from '${names.contract}';\nexport const createFixtureClient=options=>createHttpOperationClient(clientContract,options);\n`,
  );
  await build({
    entryPoints: [path.join(dirs.client, "entry.js")],
    outfile: path.join(dirs.client, "index.js"),
    bundle: true,
    minify: true,
    platform: "browser",
    format: "esm",
    external: [names.contract],
  });
  await fs.rm(path.join(dirs.client, "entry.js"));
  await fs.writeFile(
    path.join(dirs.client, "index.d.ts"),
    `import type {FixtureContract} from '${names.contract}';\nimport type {OperationClient,CreateHttpOperationClientOptions} from '@sixthsummit/ship-contract/client';\nexport declare function createFixtureClient(options:CreateHttpOperationClientOptions):OperationClient<FixtureContract>;\n`,
  );
  await build({
    entryPoints: [path.join(root, "fixtures/joint-conformance/server.ts")],
    outfile: path.join(dirs.server, "index.js"),
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    alias,
  });
  const manifest = {
    fixtureProtocolVersion: 1,
    wireFixtureVersion: 1,
    graphHash: contract.fingerprint,
    producer: {
      repository: "SixthSummit/Ship",
      head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      sourceHash: createHash("sha256")
        .update(await fs.readFile(path.join(dirs.server, "index.js")))
        .digest("hex"),
    },
    supportedCapabilities: [
      "http-json",
      "bodyless-204",
      "validation",
      "request-id",
      "cancellation",
      "primitive-forms",
      "modeled-session-refresh",
    ],
    deferredCapabilities: [
      "backend-sse",
      "backend-websocket",
      "generated-upload-binding",
      "codec-binding",
      "production-session-provider",
    ],
  };
  for (const [kind, dir] of Object.entries(dirs)) {
    const pkg = {
      name: names[kind],
      version: "0.0.0-fixture.1",
      type: "module",
      exports: {
        ".": { ...(kind !== "server" ? { types: "./index.d.ts" } : {}), import: "./index.js" },
      },
      ...(kind === "contract" ? { dependencies: { "json-schema-to-ts": "3.1.1" } } : {}),
      ...(kind === "client"
        ? { peerDependencies: { "@sixthsummit/ship-contract": ">=1.1.0" } }
        : {}),
    };
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    const tarball = kind + ".tgz";
    execFileSync("pnpm", ["pack", "--out", path.join(out, tarball)], { cwd: dir, stdio: "pipe" });
    manifest[kind + "Package"] = {
      name: pkg.name,
      version: pkg.version,
      tarball,
      sha256: createHash("sha256")
        .update(await fs.readFile(path.join(out, tarball)))
        .digest("hex"),
    };
  }
  manifest.dependencies = [];
  const schemaRequire = createRequire(
    await fs.realpath(
      path.join(root, "packages/contract/node_modules/json-schema-to-ts/package.json"),
    ),
  );
  for (const name of ["json-schema-to-ts", "ts-algebra", "@babel/runtime"]) {
    const packagePath =
      name === "json-schema-to-ts"
        ? path.join(root, "packages/contract/node_modules/json-schema-to-ts")
        : path.dirname(schemaRequire.resolve(name + "/package.json"));
    const pkg = JSON.parse(await fs.readFile(path.join(packagePath, "package.json"), "utf8"));
    const tarball = name.replaceAll("/", "-").replace("@", "") + ".tgz";
    execFileSync("pnpm", ["pack", "--out", path.join(out, tarball)], {
      cwd: packagePath,
      stdio: "pipe",
    });
    manifest.dependencies.push({
      name,
      version: pkg.version,
      tarball,
      sha256: createHash("sha256")
        .update(await fs.readFile(path.join(out, tarball)))
        .digest("hex"),
    });
  }
  manifest.artifactSetHash = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        graphHash: manifest.graphHash,
        artifacts: [
          manifest.contractPackage,
          manifest.clientPackage,
          manifest.serverPackage,
          ...manifest.dependencies,
        ].map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      }),
    )
    .digest("hex")}`;
  await fs.writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
