import { describe, expect, it, vi } from "vitest";
import { AuthenticationManager } from "./authentication_manager.js";
import { LocalSyncState } from "./local_state.js";
import { Long } from "../../vendor/long.js";
import { AuthError, IdentityVersion, Transition } from "./protocol.js";
import { Logger } from "../logging.js";

// Models an auth provider (e.g. Privy outside its 30s refresh window) that
// returns the identical still-valid JWT even for `forceRefreshToken: true`.
function fakeJwt(): string {
  const b64url = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSeconds, exp: nowSeconds + 3600 }),
  );
  return `${header}.${payload}.signature`;
}

function transition(fromIdentity: number, toIdentity: number): Transition {
  return {
    type: "Transition",
    startVersion: {
      querySet: 0,
      ts: Long.fromNumber(0),
      identity: fromIdentity,
    },
    endVersion: { querySet: 0, ts: Long.fromNumber(1), identity: toIdentity },
    modifications: [],
  };
}

function authError(baseVersion: IdentityVersion): AuthError {
  return {
    type: "AuthError",
    error: "Convex token identity expired",
    baseVersion,
    authUpdateAttempted: false,
  };
}

const silentLogger: Logger = {
  logVerbose: () => {},
  log: () => {},
  warn: () => {},
  error: () => {},
};

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function setupManager() {
  const syncState = new LocalSyncState();
  const authenticate = vi.fn((token: string): IdentityVersion => {
    const message = syncState.setAuth(token);
    return message.baseVersion;
  });
  const onAuthChange = vi.fn();
  const manager = new AuthenticationManager(
    syncState,
    {
      authenticate,
      stopSocket: () => Promise.resolve(),
      tryRestartSocket: () => {},
      pauseSocket: () => {},
      resumeSocket: () => {},
      clearAuth: () => {},
    },
    {
      refreshTokenLeewaySeconds: 10,
      logger: silentLogger,
      initialAuthTokenReuse: false,
    },
  );
  return { manager, syncState, authenticate, onAuthChange };
}

describe("AuthenticationManager", () => {
  it("does not de-authenticate when reauth refetches an identical still-valid token", async () => {
    const token = fakeJwt();
    // The provider always returns the same token, modelling a token that has
    // not yet reached its refresh window.
    const fetchToken = vi.fn(async (_args: { forceRefreshToken: boolean }) => {
      return token;
    });
    const { manager, syncState, authenticate, onAuthChange } = setupManager();

    await manager.setConfig(fetchToken, onAuthChange);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authenticate).toHaveBeenCalledWith(token);

    // The server confirms the cached token by advancing the identity version.
    manager.onTransition(transition(0, 1));
    // Let the refetch triggered by the confirmation settle (it parks in
    // `notRefetching` since the refetched token is identical).
    await flushMicrotasks();
    expect(onAuthChange).toHaveBeenCalledTimes(1);
    expect(onAuthChange).toHaveBeenCalledWith(true);
    expect(syncState.hasAuth()).toBe(true);

    // A function call is rejected for expired auth. The provider's forced
    // refresh returns the identical still-valid token.
    manager.onAuthError(authError(1));
    await flushMicrotasks();

    // The fetch succeeded, so the client must NOT report auth failure...
    expect(fetchToken).toHaveBeenCalledWith({ forceRefreshToken: true });
    expect(onAuthChange).not.toHaveBeenCalledWith(false);
    expect(syncState.hasAuth()).toBe(true);
    // ...and it must re-arm by re-sending Authenticate with the token it has.
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(authenticate).toHaveBeenLastCalledWith(token);

    // The server accepts the re-sent token: the client is back to a healthy
    // scheduled state without ever reporting a spurious de-authentication.
    manager.onTransition(transition(1, 2));
    await flushMicrotasks();
    expect(onAuthChange).toHaveBeenCalledTimes(1);
    expect(onAuthChange).not.toHaveBeenCalledWith(false);

    manager.stop();
  });

  it("still de-authenticates when the token fetch genuinely fails", async () => {
    const token = fakeJwt();
    let shouldFail = false;
    const fetchToken = vi.fn(async (_args: { forceRefreshToken: boolean }) => {
      return shouldFail ? null : token;
    });
    const { manager, authenticate, onAuthChange } = setupManager();

    await manager.setConfig(fetchToken, onAuthChange);
    manager.onTransition(transition(0, 1));
    await flushMicrotasks();
    expect(onAuthChange).toHaveBeenCalledWith(true);

    // Now the provider genuinely cannot produce a token.
    shouldFail = true;
    manager.onAuthError(authError(1));
    await flushMicrotasks();

    expect(onAuthChange).toHaveBeenCalledWith(false);
    expect(authenticate).toHaveBeenCalledTimes(1);

    manager.stop();
  });
});
