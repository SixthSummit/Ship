import { describe, expect, it } from "vitest";
import {
  planSnapshotDependents,
  releasedFromStatus,
  renderSnapshotChangeset,
} from "./snapshot-dependents.mjs";

const core = { name: "@sixthsummit/ship-core" };
const hono = { name: "@sixthsummit/ship-hono", peerDependencies: { [core.name]: "workspace:^" } };
const firebase = {
  name: "@sixthsummit/ship-auth-firebase",
  peerDependencies: { [core.name]: "workspace:^", [hono.name]: "workspace:^" },
};
const otel = {
  name: "@sixthsummit/ship-observability-otel",
  peerDependencies: { [core.name]: "workspace:^" },
};
const realtime = {
  name: "@sixthsummit/ship-realtime-socketio",
  dependencies: { [otel.name]: "workspace:^" },
};
const devOnly = {
  name: "@sixthsummit/ship-dev-only",
  devDependencies: { [core.name]: "workspace:*" },
};
const docs = {
  name: "@sixthsummit/ship-api-docs",
  private: true,
  dependencies: { [core.name]: "workspace:*" },
};
const ignored = { name: "@sixthsummit/ignored", dependencies: { [core.name]: "workspace:^" } };
const manifests = [core, hono, firebase, otel, realtime, devOnly, docs, ignored];

describe("snapshot dependents", () => {
  it("adds every publishable runtime dependent of a snapshotted package, transitively", () => {
    expect(planSnapshotDependents([core, otel, realtime], [core.name])).toEqual([
      otel.name,
      realtime.name,
    ]);
  });

  it("skips packages already in the plan, dev-only dependents, private and ignored packages", () => {
    expect(planSnapshotDependents(manifests, [core.name, hono.name], [ignored.name])).toEqual([
      firebase.name,
      otel.name,
      realtime.name,
    ]);
  });

  it("adds nothing when no snapshotted package has dependents", () => {
    expect(planSnapshotDependents(manifests, [firebase.name, realtime.name])).toEqual([]);
  });

  it("ignores status releases of type none", () => {
    expect(
      releasedFromStatus({
        releases: [
          { name: core.name, type: "minor" },
          { name: devOnly.name, type: "none" },
        ],
      }),
    ).toEqual([core.name]);
  });

  it("renders a patch changeset", () => {
    expect(renderSnapshotChangeset([firebase.name, otel.name])).toBe(
      `---\n"${firebase.name}": patch\n"${otel.name}": patch\n---\n\nSnapshot coherence: republish against the packages in this snapshot.\n`,
    );
  });
});
