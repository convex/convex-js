import { test, expect, vi } from "vitest";
import { OneoffCtx } from "../../bundler/context.js";
import { PushOptions } from "./components.js";
import { watchAndPush } from "./dev.js";

vi.mock("./components.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components.js")>();
  return { ...actual, runPush: vi.fn() };
});

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    readProjectConfig: vi.fn().mockResolvedValue({ projectConfig: {} }),
    getAuthKitConfig: vi.fn().mockResolvedValue(null),
  };
});

// No file ever changes, so `convex dev` keeps waiting after its first push.
vi.mock("./watch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./watch.js")>();
  return {
    ...actual,
    Watcher: class {
      async ready() {}
      update() {}
      waitForEvent() {
        return new Promise<void>(() => {});
      }
    },
  };
});

test("`convex dev --start` exits when its command exits", async () => {
  const ctx = {
    bigBrainAuth: () => null,
    registerCleanup: () => "cleanup",
    removeCleanup: () => null,
    flushAndExit: vi.fn(() => new Promise<never>(() => {})),
  } as unknown as OneoffCtx;
  void watchAndPush(ctx, { url: "", adminKey: "" } as PushOptions, {
    run: { kind: "shell", command: "exit 0", exitWithCommand: true },
    once: false,
    untilSuccess: false,
    traceEvents: false,
  });
  await vi.waitFor(() => expect(ctx.flushAndExit).toHaveBeenCalledWith(0));
});
