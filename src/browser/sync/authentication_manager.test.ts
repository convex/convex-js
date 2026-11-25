import { expect, test, vi } from "vitest";
import { instantiateNoopLogger } from "../logging.js";
import { AuthenticationManager } from "./authentication_manager.js";
import { LocalSyncState } from "./local_state.js";

function createManager() {
  const syncState = new LocalSyncState();
  const socket = {
    resumeSocket: vi.fn(),
    tryRestartSocket: vi.fn(),
  };
  const logger = instantiateNoopLogger({ verbose: false });
  vi.spyOn(logger, "error");
  const manager = new AuthenticationManager(
    syncState,
    {
      authenticate: (token) => syncState.setAuth(token).baseVersion,
      stopSocket: async () => {},
      pauseSocket: () => {},
      clearAuth: () => syncState.clearAuth(),
      ...socket,
    },
    {
      refreshTokenLeewaySeconds: 10,
      logger,
      initialAuthTokenReuse: false,
    },
  );
  return { manager, socket, syncState, logger };
}

test("a throwing fetchToken is handled like a null token", async () => {
  const { manager, socket, logger } = createManager();
  const onAuthChange = vi.fn();

  await manager.setConfig(async () => {
    throw new Error("Network request failed");
  }, onAuthChange);

  expect(onAuthChange).toHaveBeenCalledWith(false);
  expect(socket.resumeSocket).toHaveBeenCalled();
  expect(logger.error).toHaveBeenCalled();
});

test("the socket restarts when fetchToken throws during reauthentication", async () => {
  const { manager, socket, syncState } = createManager();
  const onAuthChange = vi.fn();
  await manager.setConfig(async ({ forceRefreshToken }) => {
    if (forceRefreshToken) {
      throw new Error("Network request failed");
    }
    return "cached-token";
  }, onAuthChange);

  manager.onAuthError({
    type: "AuthError",
    error: "Token expired",
    baseVersion: 0,
    authUpdateAttempted: true,
  });

  await vi.waitFor(() => expect(socket.tryRestartSocket).toHaveBeenCalled());
  expect(onAuthChange).toHaveBeenCalledWith(false);
  expect(syncState.hasAuth()).toBe(false);
});
