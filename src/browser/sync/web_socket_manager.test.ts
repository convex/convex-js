import { test, expect } from "vitest";
import { BaseConvexClient } from "./client.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

const jwt =
  "eyJhbGciOiJub25lIn0." +
  btoa(JSON.stringify({ sub: "u", iat: 1, exp: 9999999999 })).replace(
    /=+$/,
    "",
  ) +
  ".x";

function deferred() {
  let resolve!: (v: string | null) => void;
  const promise = new Promise<string | null>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function createClient() {
  FakeWebSocket.instances = [];
  const client = new BaseConvexClient("https://x.convex.cloud", () => {}, {
    webSocketConstructor: FakeWebSocket as any,
    unsavedChangesWarning: false,
  });
  client.subscribe("a:b", {});
  return client;
}

test("sends Connect once auth resolves after a single pause", async () => {
  const client = createClient();
  const token = deferred();
  client.setAuth(
    () => token.promise,
    () => {},
  );
  await Promise.resolve();
  FakeWebSocket.instances[0].open();
  token.resolve(jwt);
  await flush();
  const types = FakeWebSocket.instances[0].sent.map((m) => m.type);
  expect(types[0]).toBe("Connect");
  expect(types).toContain("ModifyQuerySet");
  await client.close();
});

// https://github.com/get-convex/convex-js/issues/197
test("sends Connect when paused again after the socket opened while paused", async () => {
  const client = createClient();
  const first = deferred();
  const second = deferred();
  client.setAuth(
    () => first.promise,
    () => {},
  );
  await Promise.resolve();
  FakeWebSocket.instances[0].open();
  client.setAuth(
    () => second.promise,
    () => {},
  );
  first.resolve(jwt);
  second.resolve(jwt);
  await flush();
  const types = FakeWebSocket.instances[0].sent.map((m) => m.type);
  expect(types[0]).toBe("Connect");
  expect(types).toContain("ModifyQuerySet");
  await client.close();
});
