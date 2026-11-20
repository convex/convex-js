import { once } from "events";
import { test, expect, vi } from "vitest";
import { OneoffCtx } from "../../bundler/context.js";
import { PushOptions } from "./components.js";
import { watchAndPush } from "./dev.js";

// Resolves when a command that `convex dev` started has exited, one entry per
// command, so a test can wait for it.
const commandExits: Promise<unknown>[] = [];
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const command = actual.spawn(...args);
      commandExits.push(once(command, "exit"));
      return command;
    },
  };
});

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

test("`convex dev --run-sh` keeps running when its command exits", async () => {
  const ctx = {
    bigBrainAuth: () => null,
    registerCleanup: () => "cleanup",
    removeCleanup: () => null,
    flushAndExit: vi.fn(() => new Promise<never>(() => {})),
  } as unknown as OneoffCtx;
  const started = commandExits.length;
  void watchAndPush(ctx, { url: "", adminKey: "" } as PushOptions, {
    run: { kind: "shell", command: "exit 0", exitWithCommand: false },
    once: false,
    untilSuccess: false,
    traceEvents: false,
  });
  await vi.waitFor(() => expect(commandExits).toHaveLength(started + 1));
  await commandExits[started];
  expect(ctx.flushAndExit).not.toHaveBeenCalled();
});
