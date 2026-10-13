import { expect, it } from "vitest";
import { changelogEntry } from "./notes.mjs";

it("shows only the exact version being approved, including its bump headings", () => {
  const log = "# Package\n\n## 2.0.0\n\n### Major Changes\n\nNew API.\n\n## 1.0.0\n\nOld API.\n";
  expect(changelogEntry(log, "2.0.0")).toBe("### Major Changes\n\nNew API.");
  expect(changelogEntry(log, "1.0.0")).toBe("Old API.");
  expect(() => changelogEntry(log, "3.0.0")).toThrow(/Missing changelog/);
});
