/**
 * Structural smoke test for `@sixthsummit/ship-api-claude-plugin`.
 *
 * V4_STATUS G4 slice 1. Walks the plugin tree and validates every
 * load-bearing file the Claude Code plugin loader will read at
 * activation time. Closes the "did the plugin actually wire up
 * correctly?" gap without requiring a live Claude Code instance.
 *
 * What this catches:
 *   - plugin.json missing required fields
 *   - Agent / command / skill markdown without proper YAML
 *     frontmatter (the loader rejects these silently)
 *   - hooks.json referencing scripts that don't exist or aren't
 *     executable
 *   - .mcp.json referencing a package that's not in the workspace
 *   - package.json#files missing entries that prevent the published
 *     tarball from including hooks/, .mcp.json, etc.
 *   - Skill SKILL.md files claiming source paths that don't resolve
 *
 * The flip-side validation — that the runtime LLM-driven agent
 * flow actually produces working code given a prompt — is a manual
 * verification gate (run /ship:new-module billing in a real Claude
 * Code session, eyeball the result). Not automatable in CI.
 *
 * This test runs in the default `npm test` suite — pure file
 * inspection, no Docker, no network.
 */

import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const PLUGIN_ROOT = join(REPO_ROOT, "packages", "claude-plugin");

interface MarkdownFrontmatter {
  raw: string;
  parsed: Record<string, string>;
}

/**
 * Parse Claude Code agent/command/skill frontmatter.
 *
 * NOT a full YAML parser — Claude Code's plugin loader is line-
 * oriented over `key: value`, where the value is the rest of the
 * line (trimmed) as a string. A strict YAML parser like the `yaml`
 * package rejects valid Claude Code frontmatter when the value
 * contains a colon (common in skill descriptions like "Loads
 * the v4 conventions: how to register routes ..."). This parser
 * matches the loader's behavior.
 */
async function readFrontmatter(filePath: string): Promise<MarkdownFrontmatter> {
  const content = await readFile(filePath, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error(`No YAML frontmatter found at ${filePath}`);
  }
  const raw = match[1];
  const parsed: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) parsed[key] = value;
  }
  return { raw, parsed };
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        out.push(full);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

describe("Claude Code plugin — structure validation", () => {
  it("plugin.json is valid JSON with required v0.1 fields", async () => {
    const path = join(PLUGIN_ROOT, "plugin.json");
    const json = JSON.parse(await readFile(path, "utf8"));
    expect(json.name).toBe("ship-api");
    expect(typeof json.version).toBe("string");
    expect(typeof json.description).toBe("string");
    expect(json.description.length).toBeGreaterThan(20);
  });

  it("package.json#files lists every load-bearing directory + dotfile", async () => {
    const pkg = JSON.parse(await readFile(join(PLUGIN_ROOT, "package.json"), "utf8"));
    const files = pkg.files as string[];
    // The plugin loader reads from these paths at install time. If any
    // of them are missing from package.json#files, `npm publish`
    // produces a broken tarball.
    const required = ["plugin.json", ".mcp.json", "agents/", "commands/", "skills/", "hooks/"];
    for (const r of required) {
      expect(files, `${r} must be in package.json#files`).toContain(r);
    }
  });

  describe("agents", () => {
    it("every agent .md file parses with name + description", async () => {
      const agentFiles = await listFiles(join(PLUGIN_ROOT, "agents"), ".md");
      expect(agentFiles.length).toBeGreaterThanOrEqual(3); // ship-architect / ship-codegen / ship-reviewer

      for (const file of agentFiles) {
        const fm = await readFrontmatter(file);
        const rel = relative(PLUGIN_ROOT, file);
        expect(typeof fm.parsed.name, `${rel}: name`).toBe("string");
        expect(typeof fm.parsed.description, `${rel}: description`).toBe("string");
        expect((fm.parsed.description as string).length).toBeGreaterThan(20);
        // Optional `tools` field — when present, must be a string of
        // comma-separated tool names.
        if (fm.parsed.tools !== undefined) {
          expect(typeof fm.parsed.tools).toBe("string");
        }
      }
    });

    it("the three load-bearing agents are present", async () => {
      const expected = ["ship-architect", "ship-codegen", "ship-reviewer"];
      for (const name of expected) {
        const path = join(PLUGIN_ROOT, "agents", `${name}.md`);
        const fm = await readFrontmatter(path);
        expect(fm.parsed.name).toBe(name);
      }
    });
  });

  describe("commands", () => {
    it("every command .md file parses with description", async () => {
      const commandFiles = await listFiles(join(PLUGIN_ROOT, "commands"), ".md");
      expect(commandFiles.length).toBeGreaterThanOrEqual(2);

      for (const file of commandFiles) {
        const fm = await readFrontmatter(file);
        const rel = relative(PLUGIN_ROOT, file);
        expect(typeof fm.parsed.description, `${rel}: description`).toBe("string");
        // Optional fields per Claude Code's command frontmatter spec.
        if (fm.parsed["argument-hint"] !== undefined) {
          expect(typeof fm.parsed["argument-hint"]).toBe("string");
        }
        if (fm.parsed["allowed-tools"] !== undefined) {
          expect(typeof fm.parsed["allowed-tools"]).toBe("string");
        }
      }
    });

    it("the two slash commands are present at /ship:* paths", async () => {
      const expected = ["lint-conventions.md", "new-module.md"];
      for (const name of expected) {
        const path = join(PLUGIN_ROOT, "commands", "ship", name);
        const fm = await readFrontmatter(path);
        expect(typeof fm.parsed.description).toBe("string");
      }
    });
  });

  describe("skills", () => {
    it("every SKILL.md parses with name + description; description is specific enough to trigger correctly", async () => {
      const skillFiles = await listFiles(join(PLUGIN_ROOT, "skills"), "SKILL.md");
      expect(skillFiles.length).toBeGreaterThanOrEqual(5);

      for (const file of skillFiles) {
        const fm = await readFrontmatter(file);
        const rel = relative(PLUGIN_ROOT, file);
        expect(typeof fm.parsed.name, `${rel}: name`).toBe("string");
        expect(typeof fm.parsed.description, `${rel}: description`).toBe("string");
        // Skill descriptions are the primary trigger signal Claude Code
        // uses for auto-load. Empty / generic ones never fire.
        expect(
          (fm.parsed.description as string).length,
          `${rel}: description must be substantive`,
        ).toBeGreaterThan(50);
      }
    });

    it("the five v4 skills are present", async () => {
      const expected = [
        "ship-api-conventions",
        "ship-module-pattern",
        "ship-drizzle-migrations",
        "ship-bullmq-jobs",
        "ship-otel-debugging",
      ];
      for (const name of expected) {
        const path = join(PLUGIN_ROOT, "skills", name, "SKILL.md");
        const fm = await readFrontmatter(path);
        expect(fm.parsed.name).toBe(name);
      }
    });

    it("skill source pointers cite real .cursor/rules files when referenced", async () => {
      const skillFiles = await listFiles(join(PLUGIN_ROOT, "skills"), "SKILL.md");
      for (const file of skillFiles) {
        const content = await readFile(file, "utf8");
        // Heuristic: when a skill mentions `.cursor/rules/<name>.mdc`,
        // that file must exist. Catches drift after a rule rename.
        const matches = content.matchAll(/\.cursor\/rules\/([\w-]+)\.mdc/g);
        for (const m of matches) {
          const ruleFile = join(REPO_ROOT, ".cursor", "rules", `${m[1]}.mdc`);
          await expect(stat(ruleFile)).resolves.toBeDefined();
        }
      }
    });
  });

  describe("hooks", () => {
    it("hooks.json is valid JSON; every command path resolves to an executable file", async () => {
      const hooksPath = join(PLUGIN_ROOT, "hooks", "hooks.json");
      const hooks = JSON.parse(await readFile(hooksPath, "utf8"));

      const allEvents: Array<{ command: string; event: string }> = [];
      for (const event of [
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SubagentStop",
        "SessionStart",
        "SessionEnd",
        "UserPromptSubmit",
        "PreCompact",
        "Notification",
      ]) {
        for (const entry of (hooks[event] ?? []) as Array<{
          command: string;
        }>) {
          allEvents.push({ command: entry.command, event });
        }
      }
      expect(allEvents.length).toBeGreaterThanOrEqual(3); // block-migration / maybe-review / stop-reminder

      for (const { command, event } of allEvents) {
        // Resolve `${CLAUDE_PLUGIN_ROOT}/...` against PLUGIN_ROOT for tests.
        const path = command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, PLUGIN_ROOT);
        const stats = await stat(path);
        expect(stats.isFile(), `${event}: ${command} must be a file`).toBe(true);
        // Mode bit 0o100 = owner-execute. Required for shebang scripts
        // to actually run when Claude Code spawns them.
        expect(
          stats.mode & 0o100,
          `${event}: ${command} must be executable (chmod +x)`,
        ).toBeTruthy();
      }
    });

    it("hook scripts behave correctly under smoke-test inputs", () => {
      // Exercise block-migration-edit.sh in two modes: should-block
      // (migration SQL) and should-allow (any other path). Re-runs the
      // same smoke test that's documented in the slice-2 plugin commit
      // message, so a drift in the hook (or a perms regression) shows
      // up in CI rather than only at first agent invocation.
      const hookPath = join(PLUGIN_ROOT, "hooks", "block-migration-edit.sh");

      const blockResult = spawnSync(hookPath, [], {
        input: JSON.stringify({
          tool_name: "Edit",
          tool_input: {
            file_path: "/repo/src/db/migrations/0001_init.sql",
          },
        }),
        encoding: "utf8",
      });
      expect(blockResult.status).toBe(2);
      expect(blockResult.stderr).toMatch(/blocking edit to drizzle migration/i);

      const allowResult = spawnSync(hookPath, [], {
        input: JSON.stringify({
          tool_name: "Edit",
          tool_input: { file_path: "/repo/modules/billing/schema.ts" },
        }),
        encoding: "utf8",
      });
      expect(allowResult.status).toBe(0);
    });
  });

  describe(".mcp.json", () => {
    it("is valid JSON and registers ship-api-mcp-server", async () => {
      const mcpPath = join(PLUGIN_ROOT, ".mcp.json");
      const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
      expect(mcp.mcpServers).toBeDefined();
      expect(mcp.mcpServers["ship-api"]).toBeDefined();

      // The server must be invocable via npx against the real package
      // name (workspace devDep + npm publish target).
      const args = mcp.mcpServers["ship-api"].args as string[];
      expect(args).toContain("@sixthsummit/ship-api-mcp-server");
    });

    it("references a package that exists in the workspace", async () => {
      const mcpServerPkg = JSON.parse(
        await readFile(join(REPO_ROOT, "packages", "mcp-server", "package.json"), "utf8"),
      );
      expect(mcpServerPkg.name).toBe("@sixthsummit/ship-api-mcp-server");
      // The server must declare the bin entry the .mcp.json command
      // references via npx. Without this, `npx -y @sixthsummit/...`
      // can't find the executable.
      expect(mcpServerPkg.bin?.["ship-api-mcp-server"]).toBeDefined();
    });
  });
});
