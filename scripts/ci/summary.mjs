import { pathToFileURL } from "node:url";

export function verifyResults(jobs) {
  if (jobs.plan?.result !== "success") return false;
  const mapping = {
    api: "api",
    angular: "angular",
    "api-docs": "apiDocs",
    "angular-docs": "angularDocs",
  };
  return Object.entries(mapping).every(([job, output]) => {
    const selected = jobs.plan.outputs?.[output];
    if (selected !== "true" && selected !== "false") return false;
    return jobs[job]?.result === (selected === "true" ? "success" : "skipped");
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!verifyResults(JSON.parse(process.env.JOB_RESULTS ?? "{}"))) {
    console.error("A selected check did not succeed, or the verification plan is invalid.");
    process.exitCode = 1;
  }
}
