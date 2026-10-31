import { afterEach, describe, expect, it, vi } from "vitest";
import { installSigintHandler, type OneoffCtx } from "./context.js";

// Only the handler is under test; do not initialize deployment selection.
vi.mock("../cli/lib/deploymentSelection.js", () => ({}));
vi.mock("../cli/lib/envvars.js", () => ({}));
vi.mock("./log.js", () => ({ logVerbose: vi.fn() }));

describe("CLI shutdown signals", () => {
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const handlers = new Map<string | symbol, () => void>();
    vi.spyOn(process, "on").mockImplementation((signal, handler) => {
      handlers.set(signal, handler);
      return process;
    });
    const flushAndExit = vi.fn(() => new Promise<never>(() => {}));
    installSigintHandler({ flushAndExit } as unknown as OneoffCtx);
    return { handlers, flushAndExit };
  }

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("runs cleanup on %s", (signal, code) => {
    const { handlers, flushAndExit } = setup();
    expect(handlers.has(signal)).toBe(true);
    void handlers.get(signal)!();
    expect(flushAndExit).toHaveBeenCalledExactlyOnceWith(code);
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "ignores duplicate and mixed signals during cleanup started by %s",
    (signal) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("exit");
      });
      const { handlers, flushAndExit } = setup();
      void handlers.get(signal)!();
      now.mockReturnValue(1499);
      void handlers.get("SIGINT")!();
      void handlers.get("SIGTERM")!();
      expect(flushAndExit).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("force exits on a later %s", async (signal, code) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const { handlers, flushAndExit } = setup();
    void handlers.get(signal === "SIGINT" ? "SIGTERM" : "SIGINT")!();
    now.mockReturnValue(1500);
    await expect(handlers.get(signal)!()).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
    expect(flushAndExit).toHaveBeenCalledTimes(1);
  });
});
