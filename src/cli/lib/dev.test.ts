import { once } from "events";
import { test, expect, vi } from "vitest";
import { OneoffCtx } from "../../bundler/context.js";
import { normalizeDevOptions } from "./command.js";
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

// A context whose exit, like the real one, takes the registered cleanups and
// never returns. It does not run them, as if an earlier cleanup were still
// running.
function fakeContext() {
  const cleanups = new Map<string, unknown>();
  let registered = 0;
  return {
    bigBrainAuth: () => null,
    registerCleanup: (fn: unknown) => {
      const handle = `cleanup${registered++}`;
      cleanups.set(handle, fn);
      return handle;
    },
    removeCleanup: (handle: string) => {
      const fn = cleanups.get(handle) ?? null;
      cleanups.delete(handle);
      return fn;
    },
    flushAndExit: vi.fn(() => {
      cleanups.clear();
      return new Promise<never>(() => {});
    }),
  } as unknown as OneoffCtx;
}

// Runs `convex dev` with a `--start` command, or with a `--run-sh` command
// when `exitWithCommand` is false.
function dev(
  ctx: OneoffCtx,
  command: string,
  options: { exitWithCommand?: boolean; once?: boolean } = {},
) {
  return watchAndPush(ctx, { url: "", adminKey: "" } as PushOptions, {
    run: {
      kind: "shell",
      command,
      exitWithCommand: options.exitWithCommand ?? true,
    },
    once: options.once ?? false,
    untilSuccess: false,
    traceEvents: false,
  });
}

test("`convex dev --start` exits when its command exits", async () => {
  const ctx = fakeContext();
  void dev(ctx, "exit 0");
  await vi.waitFor(() => expect(ctx.flushAndExit).toHaveBeenCalledWith(0));
});

test("`convex dev --run-sh` keeps running when its command exits", async () => {
  const ctx = fakeContext();
  const started = commandExits.length;
  void dev(ctx, "exit 0", { exitWithCommand: false });
  await vi.waitFor(() => expect(commandExits).toHaveLength(started + 1));
  await commandExits[started];
  expect(ctx.flushAndExit).not.toHaveBeenCalled();
});

test("only `--start` makes `convex dev` exit with its command", async () => {
  const ctx = fakeContext();
  const options = {
    typecheck: "disable",
    codegen: "disable",
    untilSuccess: false,
    traceEvents: false,
  } as const;
  const start = await normalizeDevOptions(ctx, { ...options, start: "vite" });
  const runSh = await normalizeDevOptions(ctx, { ...options, runSh: "vite" });
  expect(start.run).toMatchObject({ exitWithCommand: true });
  expect(runSh.run).toMatchObject({ exitWithCommand: false });
});

test("`convex dev --start` exits with code 1 when its command fails", async () => {
  const ctx = fakeContext();
  const started = commandExits.length;
  void dev(ctx, "exit 7");
  await vi.waitFor(() => expect(commandExits).toHaveLength(started + 1));
  await commandExits[started];
  expect(ctx.flushAndExit).toHaveBeenCalledExactlyOnceWith(1);
});

test("`convex dev --once --start` waits for the exit that its failed command started", async () => {
  const ctx = fakeContext();
  let returned = false;
  void dev(ctx, "exit 7", { once: true }).then(() => {
    returned = true;
  });
  await vi.waitFor(() => expect(ctx.flushAndExit).toHaveBeenCalledWith(1));
  expect(returned).toBe(false);
});

test("`convex dev --start` exits with code 130 on Ctrl+C when its command then exits with code 0", async () => {
  const ctx = fakeContext();
  // Stands in for the SIGINT handler that `convex dev` installs.
  process.once("SIGINT", () => void ctx.flushAndExit(130));
  const started = commandExits.length;
  void dev(ctx, "trap 'exit 0' INT; while :; do sleep 0.05; done");
  await vi.waitFor(() => expect(commandExits).toHaveLength(started + 1));
  // Give the shell time to set its trap.
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.emit("SIGINT");
  await commandExits[started];
  expect(ctx.flushAndExit).toHaveBeenCalledExactlyOnceWith(130);
});

test("`convex dev --start` does not exit a second time when its command exits during an exit", async () => {
  const ctx = fakeContext();
  const started = commandExits.length;
  void dev(ctx, "sleep 0.5");
  await vi.waitFor(() => expect(commandExits).toHaveLength(started + 1));
  // `convex dev` fails elsewhere, and its cleanup is still running when the
  // command exits.
  void ctx.flushAndExit(1);
  await commandExits[started];
  expect(ctx.flushAndExit).toHaveBeenCalledExactlyOnceWith(1);
});
