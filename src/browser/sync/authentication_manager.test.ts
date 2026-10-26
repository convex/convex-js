import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { instantiateNoopLogger } from "../logging.js";
import { AuthenticationManager } from "./authentication_manager.js";
import { LocalSyncState } from "./local_state.js";
import { Authenticate, Transition } from "./protocol.js";
import { Long } from "../../vendor/long.js";

const LIFETIME_SECONDS = 900;
const LEEWAY_SECONDS = 60;

function jwt(issuedAtMs: number) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(issuedAtMs / 1000);
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ sub: "user", iat, exp: iat + LIFETIME_SECONDS }),
    "signature",
  ].join(".");
}

function setup() {
  const syncState = new LocalSyncState();
  const sent: (Authenticate & { sentAt: number })[] = [];
  const manager = new AuthenticationManager(
    syncState,
    {
      authenticate: (token) => {
        const message = syncState.setAuth(token);
        sent.push({ ...message, sentAt: Date.now() });
        return message.baseVersion;
      },
      stopSocket: async () => {},
      tryRestartSocket: () => {},
      pauseSocket: () => {},
      resumeSocket: () => {},
      clearAuth: () => {
        sent.push({ ...syncState.clearAuth(), sentAt: Date.now() });
      },
    },
    {
      refreshTokenLeewaySeconds: LEEWAY_SECONDS,
      logger: instantiateNoopLogger({ verbose: false }),
      initialAuthTokenReuse: true,
    },
  );
  // The server confirms the token the client last sent.
  const confirm = () => {
    const identity = sent.length;
    const ts = Long.fromNumber(0);
    manager.onTransition({
      type: "Transition",
      startVersion: { querySet: 0, ts, identity: identity - 1 },
      endVersion: { querySet: 0, ts, identity },
      modifications: [],
      clientClockSkew: 0,
    } satisfies Transition);
  };
  return { manager, sent, confirm };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a refresh that fails before expiry keeps the current token", async () => {
  const { manager, sent, confirm } = setup();
  const token = jwt(Date.now());
  let refreshed: string | null = null;
  const fetchToken = vi.fn(async ({ forceRefreshToken }) =>
    forceRefreshToken ? refreshed : token,
  );
  const onChange = vi.fn();

  await manager.setConfig(fetchToken, onChange);
  confirm();
  expect(onChange).toHaveBeenLastCalledWith(true);

  // The scheduled refresh runs `LEEWAY_SECONDS` before expiry and fails.
  await vi.advanceTimersByTimeAsync((LIFETIME_SECONDS - LEEWAY_SECONDS) * 1000);
  expect(fetchToken).toHaveBeenLastCalledWith({ forceRefreshToken: true });
  expect(sent.map((message) => message.tokenType)).toEqual(["User"]);
  expect(onChange).not.toHaveBeenCalledWith(false);

  // A later attempt, still before expiry, gets a fresh token.
  refreshed = jwt(Date.now());
  await vi.advanceTimersByTimeAsync(LEEWAY_SECONDS * 1000);
  expect(sent.at(-1)).toMatchObject({ tokenType: "User", value: refreshed });
  expect(onChange).not.toHaveBeenCalledWith(false);
});

test("a refresh that keeps failing clears auth before the token expires", async () => {
  const { manager, sent, confirm } = setup();
  const issuedAt = Date.now();
  const token = jwt(issuedAt);
  const fetchToken = vi.fn(async ({ forceRefreshToken }) =>
    forceRefreshToken ? null : token,
  );
  const onChange = vi.fn();

  await manager.setConfig(fetchToken, onChange);
  confirm();

  await vi.advanceTimersByTimeAsync(LIFETIME_SECONDS * 1000);

  expect(sent.map((message) => message.tokenType)).toEqual(["User", "None"]);
  expect(onChange).toHaveBeenLastCalledWith(false);
  // Retried until the token was about to expire, then signed out.
  const clearedAfterMs = sent[1]!.sentAt - issuedAt;
  expect(clearedAfterMs).toBeGreaterThan((LIFETIME_SECONDS - 5) * 1000);
  expect(clearedAfterMs).toBeLessThan(LIFETIME_SECONDS * 1000);
  expect(fetchToken.mock.calls.length).toBeGreaterThan(3);
});
