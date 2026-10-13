import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

execFileSync("pnpm", ["exec", "changeset", "status", "--output", "release-plan.json"], {
  stdio: "inherit",
});
const plan = JSON.parse(readFileSync("release-plan.json", "utf8"));
const lines = [
  "## Pending release plan",
  "",
  "Changesets accumulate until a stable release; this is the complete pending plan.",
  "",
  "| Package | Current | Proposed | Bump | Changesets |",
  "| --- | --- | --- | --- | --- |",
];
for (const release of plan.releases ?? []) {
  if (release.type === "none" || !release.oldVersion || !release.newVersion) continue;
  lines.push(
    `| ${release.name} | ${release.oldVersion} | ${release.newVersion} | ${release.type} | ${(release.changesets ?? []).join(", ") || "dependency propagation"} |`,
  );
}
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
