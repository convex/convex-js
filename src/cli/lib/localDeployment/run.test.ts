import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "../../../bundler/context.js";
import { localBackendInterface } from "./run.js";

function fakeCtx(): Context {
  return {
    crash: async ({ printedMessage }: any): Promise<never> => {
      throw new Error(`crashed: ${printedMessage}`);
    },
  } as unknown as Context;
}

describe("localBackendInterface", () => {
  afterEach(() => {
    delete process.env.CONVEX_LOCAL_BACKEND_INTERFACE;
  });

  it("defaults to loopback so local backends are not reachable from the network (convex/convex-js#200)", async () => {
    await expect(localBackendInterface(fakeCtx())).resolves.toBe("127.0.0.1");
  });

  it("honors an explicit interface for machines that deliberately serve a local deployment", async () => {
    process.env.CONVEX_LOCAL_BACKEND_INTERFACE = "0.0.0.0";
    await expect(localBackendInterface(fakeCtx())).resolves.toBe("0.0.0.0");
  });

  it("rejects a blank interface instead of silently binding to every interface", async () => {
    process.env.CONVEX_LOCAL_BACKEND_INTERFACE = "   ";
    await expect(localBackendInterface(fakeCtx())).rejects.toThrow(
      "Invalid CONVEX_LOCAL_BACKEND_INTERFACE",
    );
  });
});
