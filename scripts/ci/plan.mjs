import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function classifyChanges(paths, full = false) {
  const plan = { api: full, angular: full, apiDocs: full, angularDocs: full };
  for (const file of paths) {
    if (/^(docs\/|apps\/docs\/)/.test(file)) plan.apiDocs = true;
    else if (/^(angular\/docs\/|apps\/angular-docs\/)/.test(file)) plan.angularDocs = true;
    else if (/^\.changeset\/[^/]+\.md$/.test(file)) continue;
    else if (/\.md$/.test(file) && !file.includes("/templates/")) {
      if (file.startsWith("angular/")) plan.angularDocs = true;
      else if (file.startsWith("packages/angular/")) plan.angular = true;
      else plan.apiDocs = true;
    } else if (/^(angular\/|packages\/angular\/)/.test(file)) plan.angular = true;
    else if (
      /^(packages\/(kernel|contract|hono|cli|realtime-socketio)\/|fixtures\/joint-conformance\/|scripts\/build-joint-conformance\.mjs)/.test(
        file,
      )
    ) {
      plan.api = true;
      plan.angular = true;
    } else if (/^(packages\/|modules\/|libraries\/|fixtures\/|scripts\/edge-smoke\/)/.test(file))
      plan.api = true;
    else
      Object.keys(plan).forEach((key) => {
        plan[key] = true;
      });
  }
  return plan;
}

export function changedPaths(base, head = "HEAD") {
  if (!base || /^0+$/.test(base)) return { paths: [], full: true };
  try {
    for (const ref of [base, head])
      execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
        stdio: "pipe",
      });
    const paths = execFileSync(
      "git",
      ["diff", "--no-renames", "--name-only", "-z", base, head, "--"],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    return { paths, full: false };
  } catch {
    // Initial pushes, missing history, or an invalid base must never silently skip checks.
    return { paths: [], full: true };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const diff = changedPaths(process.env.CI_BASE, process.env.CI_HEAD ?? "HEAD");
  const plan = classifyChanges(diff.paths, diff.full || process.env.CI_FULL === "true");
  writeFileSync("ci-plan.json", `${JSON.stringify({ ...plan, ...diff }, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT)
    for (const [key, value] of Object.entries(plan))
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Verification plan\n\n${Object.entries(plan)
        .map(([key, value]) => `- ${key}: ${value ? "run" : "unchanged"}`)
        .join(
          "\n",
        )}\n\n${diff.full ? "Full verification: comparison base unavailable." : `${diff.paths.length} changed paths.`}\n`,
    );
  console.log(JSON.stringify(plan));
}
