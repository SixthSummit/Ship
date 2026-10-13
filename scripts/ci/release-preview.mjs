import { appendFileSync, writeFileSync } from "node:fs";
import { getReleasePlan } from "@changesets/get-release-plan";

const plan = await getReleasePlan(process.cwd());
writeFileSync("release-plan.json", `${JSON.stringify(plan, null, 2)}\n`);
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
