import { describe, expect, it } from "vitest";
import { Logger } from "../logging.js";
import {
  AuthenticationManager,
  AuthTokenFetcher,
} from "./authentication_manager.js";
import { LocalSyncState } from "./local_state.js";
import { AuthError } from "./protocol.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const noop = () => {};

function silentLogger(): Logger {
  return {
    logVerbose: noop,
    log: noop,
    warn: noop,
    error: noop,
  };
}

type SocketStub = {
  // Mirrors the WebSocketManager states relevant to this test:
  // "stopped" is only exited via tryRestart(), and pause()/resume()
  // intentionally leave a stopped socket stopped.
  stopped: boolean;
  restarts: number;
  stopSocketImpl: () => Promise<void>;
};

function makeManager(
  syncState: LocalSyncState,
  socket: SocketStub,
): AuthenticationManager {
  return new AuthenticationManager(
    syncState,
    {
      authenticate: (token: string) => {
        const message = syncState.setAuth(token);
        return message.baseVersion;
      },
      stopSocket: async () => {
        await socket.stopSocketImpl();
        socket.stopped = true;
      },
      tryRestartSocket: () => {
        if (socket.stopped) {
          socket.stopped = false;
          socket.restarts += 1;
        }
      },
      // pause() and resume() return early for a stopped socket.
      pauseSocket: noop,
      resumeSocket: noop,
      clearAuth: noop,
    },
    {
      logger: silentLogger(),
      refreshTokenLeewaySeconds: 60,
      initialAuthTokenReuse: false,
    },
  );
}

function authError(): AuthError {
  return {
    type: "AuthError",
    error: "expired",
    baseVersion: 0,
    authUpdateAttempted: true,
  };
}

// A fetcher whose forced (reauthentication) fetch stays pending until released.
function makeReauthFetcher() {
  let release!: (token: string) => void;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const fetchToken: AuthTokenFetcher = async ({ forceRefreshToken }) => {
    calls += 1;
    if (forceRefreshToken) {
      return pending;
    }
    return `token-${calls}`;
  };
  return { fetchToken, release };
}

describe("setAuth during reauthentication (convex/convex-js#194)", () => {
  it("restarts the socket when setConfig runs while the reauth fetch is pending", async () => {
    const syncState = new LocalSyncState();
    const socket: SocketStub = {
      stopped: false,
      restarts: 0,
      stopSocketImpl: () => Promise.resolve(),
    };
    const manager = makeManager(syncState, socket);

    // 1. Authenticate normally.
    const { fetchToken, release } = makeReauthFetcher();
    await manager.setConfig(fetchToken, noop, noop);
    expect(syncState.hasAuth()).toBe(true);

    // 2. The server rejects the token. tryToReauthenticate stops the socket
    //    and starts a forced token fetch, which stays pending.
    manager.onAuthError(authError());
    await tick();
    await tick();
    expect(socket.stopped).toBe(true);

    // 3. While that fetch is pending, the app calls setAuth again.
    await manager.setConfig(async () => "token-new", noop, noop);

    // 4. The reauthentication fetch resolves late; its config is outdated.
    release("token-late");
    await tick();
    await tick();

    // The socket must have been restarted by setConfig, not left stopped.
    expect(socket.restarts).toBe(1);
    expect(socket.stopped).toBe(false);
    // The new token won, not the late reauthentication token.
    expect(syncState.getAuth()?.value).toBe("token-new");
  });

  it("restarts the socket when setConfig runs while stopSocket is still closing", async () => {
    const syncState = new LocalSyncState();
    let releaseStop!: () => void;
    const stopPending = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const socket: SocketStub = {
      stopped: false,
      restarts: 0,
      stopSocketImpl: () => stopPending,
    };
    const manager = makeManager(syncState, socket);

    // 1. Authenticate normally.
    await manager.setConfig(async () => "token-first", noop, noop);

    // 2. AuthError arrives; tryToReauthenticate awaits stopSocket(), which
    //    stays pending.
    manager.onAuthError(authError());
    await tick();
    await tick();
    expect(socket.stopped).toBe(false);

    // 3. setConfig starts while stopSocket is still closing; its own fetch
    //    stays pending too.
    let releaseFetch!: (token: string) => void;
    const fetchPending = new Promise<string>((resolve) => {
      releaseFetch = resolve;
    });
    const setConfigPromise = manager.setConfig(
      async () => fetchPending,
      noop,
      noop,
    );
    await tick();

    // 4. stopSocket resolves while setConfig is between resetAuthState and its
    //    fetch resolving, so tryToReauthenticate returns early without
    //    restarting the socket.
    releaseStop();
    await tick();
    await tick();
    expect(socket.stopped).toBe(true);

    // 5. setConfig's fetch resolves; it authenticates the new token.
    releaseFetch("token-second");
    await setConfigPromise;
    await tick();

    expect(socket.restarts).toBe(1);
    expect(socket.stopped).toBe(false);
    expect(syncState.getAuth()?.value).toBe("token-second");
  });
});
