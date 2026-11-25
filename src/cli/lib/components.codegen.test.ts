import { describe, expect, it } from "vitest";
import { isDryRunStartPush } from "./components.js";

describe("isDryRunStartPush", () => {
  it("marks codegen pushes as dry runs so start_push does not create tables or indexes", () => {
    // A normal deploy mutates the deployment.
    expect(isDryRunStartPush({ dryRun: false, codegen: false })).toBe(false);
    // `npx convex deploy --dry-run` previews without mutating.
    expect(isDryRunStartPush({ dryRun: true, codegen: false })).toBe(true);
    // `npx convex codegen` is read-only: it needs the backend's evaluated
    // schema for the generated bindings, but it must not create tables or
    // indexes on the deployment (convex/convex-js#199).
    expect(isDryRunStartPush({ dryRun: false, codegen: true })).toBe(true);
    expect(isDryRunStartPush({ dryRun: true, codegen: true })).toBe(true);
  });
});
