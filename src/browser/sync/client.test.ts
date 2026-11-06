import { expect, test, vi } from "vitest";
import { makeFunctionReference } from "../../server/api.js";
import { convexToJson, Value } from "../../values/index.js";
import { Long } from "../../vendor/long.js";
import { BaseConvexClient, BaseConvexClientOptions } from "./client.js";
import {
  nodeWebSocket,
  withInMemoryWebSocket,
} from "./client_node_test_helpers.js";
import {
  ClientMessage,
  QueryId,
  StateModification,
  StateVersion,
  WireServerMessage,
} from "./protocol.js";

type Connection = {
  client: BaseConvexClient;
  server: ScriptedServer;
  receive: () => Promise<ClientMessage>;
  close: () => void;
};

/** Tracks the server's state version so tests only name what changes. */
class ScriptedServer {
  private version = ScriptedServer.initialVersion();
  private ts = 0;

  constructor(private readonly send: (message: WireServerMessage) => void) {}

  private static initialVersion(): StateVersion {
    return { querySet: 0, identity: 0, ts: Long.fromNumber(0) };
  }

  transition(
    modifications: StateModification[],
    version: { querySet?: number; identity?: number } = {},
  ) {
    const startVersion = this.version;
    this.version = {
      querySet: version.querySet ?? startVersion.querySet,
      identity: version.identity ?? startVersion.identity,
      ts: Long.fromNumber(++this.ts),
    };
    this.send({
      type: "Transition",
      startVersion,
      endVersion: this.version,
      modifications,
    });
  }

  /** Commits the mutation at the timestamp of the next transition. */
  mutationResponse(requestId: number) {
    this.send({
      type: "MutationResponse",
      requestId,
      success: true,
      result: null,
      ts: Long.fromNumber(this.ts + 1),
      logLines: [],
    });
  }

  mutationFailed(requestId: number) {
    this.send({
      type: "MutationResponse",
      requestId,
      success: false,
      result: "failed",
      logLines: [],
    });
  }

  reconnected() {
    this.version = ScriptedServer.initialVersion();
  }
}

const updated = (queryId: QueryId, value: Value): StateModification => ({
  type: "QueryUpdated",
  queryId,
  value: convexToJson(value),
  logLines: [],
  journal: null,
});

const fakeJwt = () => {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  return `${encode({ alg: "none" })}.${encode({ sub: "ada", iat, exp: iat + 3600 })}.sig`;
};

async function withClient(
  cb: (connection: Connection) => Promise<void>,
  options: BaseConvexClientOptions = {},
) {
  await withInMemoryWebSocket(async ({ address, receive, send, close }) => {
    const client = new BaseConvexClient(address, () => {}, {
      webSocketConstructor: nodeWebSocket,
      unsavedChangesWarning: false,
      logger: false,
      ...options,
    });
    try {
      expect(await receive()).toMatchObject({ type: "Connect" });
      expect(await receive()).toMatchObject({
        type: "ModifyQuerySet",
        baseVersion: 0,
        newVersion: 1,
      });
      await cb({ client, server: new ScriptedServer(send), receive, close });
    } finally {
      await client.close();
    }
  });
}

const optimisticQueryResults = (client: BaseConvexClient) =>
  (client as any).optimisticQueryResults;

test("sends the query set edits of one microtask as one message", async () => {
  await withClient(async ({ client, server, receive }) => {
    const subscriptions = ["a", "b", "c", "a"].map((value) =>
      client.subscribe("test:echo", { value }),
    );
    expect(await receive()).toMatchObject({
      type: "ModifyQuerySet",
      baseVersion: 1,
      newVersion: 4,
      modifications: [
        { type: "Add", queryId: 0 },
        { type: "Add", queryId: 1 },
        { type: "Add", queryId: 2 },
      ],
    });
    server.transition([updated(0, "a"), updated(1, "b"), updated(2, "c")], {
      querySet: 4,
    });
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:echo", { value: "c" })).toBe("c"),
    );

    subscriptions.forEach(({ unsubscribe }) => unsubscribe());
    expect(await receive()).toMatchObject({
      type: "ModifyQuerySet",
      baseVersion: 4,
      newVersion: 7,
      modifications: [
        { type: "Remove", queryId: 1 },
        { type: "Remove", queryId: 2 },
        { type: "Remove", queryId: 0 },
      ],
    });
  });
});

test("sends the args a query had when subscribed", async () => {
  await withClient(async ({ client, receive }) => {
    const args = { value: "a" };
    client.subscribe("test:echo", args);
    args.value = "b";

    expect(await receive()).toMatchObject({
      modifications: [{ type: "Add", queryId: 0, args: [{ value: "a" }] }],
    });
  });
});

test("sends a subscribe and unsubscribe of one microtask together", async () => {
  await withClient(async ({ client, server, receive }) => {
    const a = client.subscribe("test:echo", { value: "a" });
    a.unsubscribe();
    client.subscribe("test:count", {});

    expect(await receive()).toMatchObject({
      baseVersion: 1,
      newVersion: 4,
      modifications: [
        { type: "Add", queryId: 0 },
        { type: "Remove", queryId: 0 },
        { type: "Add", queryId: 1 },
      ],
    });
    server.transition([updated(1, 0)], { querySet: 4 });
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:count", {})).toBe(0),
    );
    expect(client.hasLocalQueryResultByToken(a.queryToken)).toBe(false);
    expect(client.localQueryResult("test:echo", { value: "a" })).toBe(
      undefined,
    );
  });
});

test("sends queued query set edits before a later message", async () => {
  await withClient(async ({ client, server, receive }) => {
    client.subscribe("test:count", {});
    const mutation = client.mutation("test:add", { text: "x" });

    expect(await receive()).toMatchObject({
      type: "ModifyQuerySet",
      modifications: [{ type: "Add", queryId: 0 }],
    });
    const request = await receive();
    expect(request).toMatchObject({ type: "Mutation" });

    server.mutationResponse((request as { requestId: number }).requestId);
    server.transition([updated(0, 1)], { querySet: 2 });
    await mutation;
  });
});

test("applies a transition or mutation response to the queries it names", async () => {
  await withClient(async ({ client, server, receive }) => {
    const a = client.subscribe("test:echo", { value: "a" });
    const count = client.subscribe("test:count", {});
    await receive();
    server.transition([updated(0, "a"), updated(1, 0)], { querySet: 2 });
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:count", {})).toBe(0),
    );
    const before = optimisticQueryResults(client).rawQueryResult(a.queryToken);
    const changed: string[][] = [];
    client.addOnTransitionHandler(({ queries }) =>
      changed.push(queries.map(({ token }) => token)),
    );
    const rebuild = vi.spyOn(
      optimisticQueryResults(client),
      "ingestQueryResultsFromServer",
    );

    server.transition([updated(1, 1)]);
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:count", {})).toBe(1),
    );
    const mutation = client.mutation("test:add", { text: "y" });
    const request = await receive();
    expect(request).toMatchObject({ type: "Mutation" });
    server.mutationResponse((request as { requestId: number }).requestId);
    server.transition([updated(1, 2)]);
    await mutation;
    const failing = client.mutation("test:add", { text: "z" });
    server.mutationFailed(
      ((await receive()) as { requestId: number }).requestId,
    );
    await expect(failing).rejects.toThrow("failed");

    expect(client.localQueryResult("test:count", {})).toBe(2);
    expect(changed).toEqual([[count.queryToken], [count.queryToken], []]);
    expect(optimisticQueryResults(client).rawQueryResult(a.queryToken)).toBe(
      before,
    );
    expect(rebuild).not.toHaveBeenCalled();
  });
});

test("drops an unsubscribed result on the next transition", async () => {
  await withClient(async ({ client, server, receive }) => {
    const a = client.subscribe("test:echo", { value: "a" });
    client.subscribe("test:count", {});
    await receive();
    server.transition([updated(0, "a"), updated(1, 0)], { querySet: 2 });
    await vi.waitFor(() =>
      expect(client.hasLocalQueryResultByToken(a.queryToken)).toBe(true),
    );

    a.unsubscribe();
    expect(await receive()).toMatchObject({ type: "ModifyQuerySet" });
    server.transition([updated(1, 1)], { querySet: 3 });

    await vi.waitFor(() =>
      expect(client.localQueryResult("test:count", {})).toBe(1),
    );
    expect(client.hasLocalQueryResultByToken(a.queryToken)).toBe(false);
  });
});

test("drops a resubscribed result until the server sends the new one", async () => {
  await withClient(async ({ client, server, receive }) => {
    const a = client.subscribe("test:echo", { value: "a" });
    client.subscribe("test:count", {});
    await receive();
    server.transition([updated(0, "a"), updated(1, 0)], { querySet: 2 });
    await vi.waitFor(() =>
      expect(client.hasLocalQueryResultByToken(a.queryToken)).toBe(true),
    );

    a.unsubscribe();
    client.subscribe("test:echo", { value: "a" });
    expect(await receive()).toMatchObject({
      modifications: [
        { type: "Remove", queryId: 0 },
        { type: "Add", queryId: 2 },
      ],
    });
    server.transition([updated(1, 1)]);
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:count", {})).toBe(1),
    );
    expect(client.hasLocalQueryResultByToken(a.queryToken)).toBe(false);

    server.transition([updated(2, "a")], { querySet: 4 });
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:echo", { value: "a" })).toBe("a"),
    );
  });
});

test("replays optimistic updates over every result until the server confirms", async () => {
  await withClient(async ({ client, server, receive }) => {
    client.subscribe("test:count", {});
    client.subscribe("test:echo", { value: "a" });
    await receive();
    server.transition([updated(0, 0), updated(1, "a")], { querySet: 2 });
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:count", {})).toBe(0),
    );

    const count = makeFunctionReference<"query", Record<string, never>, number>(
      "test:count",
    );
    const mutation = client.mutation(
      "test:add",
      { text: "x" },
      {
        optimisticUpdate: (store) =>
          store.setQuery(count, {}, (store.getQuery(count, {}) ?? 0) + 10),
      },
    );
    expect(client.localQueryResult("test:count", {})).toBe(10);

    const request = await receive();
    server.transition([updated(0, 1)]);
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:count", {})).toBe(11),
    );
    server.mutationResponse((request as { requestId: number }).requestId);
    server.transition([updated(0, 2)]);
    await mutation;

    expect(client.localQueryResult("test:count", {})).toBe(2);
    expect(client.localQueryResult("test:echo", { value: "a" })).toBe("a");
  });
});

test("rebuilds every result on the first transition after a reconnect", async () => {
  await withClient(async ({ client, server, receive, close }) => {
    const a = client.subscribe("test:echo", { value: "a" });
    const c = client.subscribe("test:echo", { value: "c" });
    await receive();
    server.transition([updated(0, "a"), updated(1, "c")], { querySet: 2 });
    await vi.waitFor(() =>
      expect(client.hasLocalQueryResultByToken(c.queryToken)).toBe(true),
    );

    close();
    await vi.waitFor(() =>
      expect(client.connectionState().isWebSocketConnected).toBe(false),
    );
    a.unsubscribe();
    const b = client.subscribe("test:echo", { value: "b" });

    expect(await receive()).toMatchObject({ type: "Connect" });
    expect(await receive()).toMatchObject({
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications: [
        { type: "Add", queryId: 1 },
        { type: "Add", queryId: 2 },
      ],
    });
    server.reconnected();
    server.transition([updated(2, "b")], { querySet: 1 });

    await vi.waitFor(() =>
      expect(client.hasLocalQueryResultByToken(b.queryToken)).toBe(true),
    );
    expect(client.hasLocalQueryResultByToken(a.queryToken)).toBe(false);
    expect(client.hasLocalQueryResultByToken(c.queryToken)).toBe(false);
  });
}, 10000);

test("sends queued edits before pausing for auth", async () => {
  await withClient(async ({ client, server, receive }) => {
    client.subscribe("test:whoami", {});
    client.setAuth(
      async () => fakeJwt(),
      () => {},
    );

    expect(await receive()).toMatchObject({
      type: "ModifyQuerySet",
      baseVersion: 1,
      newVersion: 2,
      modifications: [{ type: "Add", queryId: 0 }],
    });
    expect(await receive()).toMatchObject({
      type: "Authenticate",
      baseVersion: 0,
    });
    server.transition([updated(0, "ada")], { querySet: 2, identity: 1 });
    await vi.waitFor(() =>
      expect(client.localQueryResult("test:whoami", {})).toBe("ada"),
    );
  });
});

test("sends edits made while paused for auth on resume", async () => {
  await withClient(async ({ client, receive }) => {
    let resolveToken!: (token: string) => void;
    client.setAuth(
      () => new Promise((resolve) => (resolveToken = resolve)),
      () => {},
    );
    client.subscribe("test:whoami", {});
    resolveToken(fakeJwt());

    expect(await receive()).toMatchObject({ type: "Authenticate" });
    expect(await receive()).toMatchObject({
      type: "ModifyQuerySet",
      baseVersion: 1,
      newVersion: 2,
      modifications: [{ type: "Add", queryId: 0 }],
    });
  });
});
