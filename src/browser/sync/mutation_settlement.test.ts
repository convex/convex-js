import { expect, test, vi } from "vitest";
import { makeFunctionReference } from "../../server/api.js";
import { Long } from "../../vendor/long.js";
import { BaseConvexClient } from "./client.js";
import {
  nodeWebSocket,
  withInMemoryWebSocket,
} from "./client_node_test_helpers.js";

test("an already applied mutation drops its optimistic update before the promise continuation", async () => {
  await withInMemoryWebSocket(async ({ address, receive, send }) => {
    const client = new BaseConvexClient(address, () => {}, {
      webSocketConstructor: nodeWebSocket,
      logger: false,
      unsavedChangesWarning: false,
      skipConvexDeploymentUrlCheck: true,
    });
    try {
      await receive();
      await receive();
      const { queryToken } = client.subscribe("counter:get", {});
      const modification = await receive();
      if (modification.type !== "ModifyQuerySet")
        throw new Error("Expected query set modification");
      const add = modification.modifications[0];
      if (add.type !== "Add") throw new Error("Expected query addition");
      const initialVersion = {
        querySet: 1,
        identity: 0,
        ts: Long.fromNumber(1),
      };
      send({
        type: "Transition",
        startVersion: { querySet: 0, identity: 0, ts: Long.fromNumber(0) },
        endVersion: initialVersion,
        modifications: [
          {
            type: "QueryUpdated",
            queryId: add.queryId,
            value: 0,
            logLines: [],
            journal: null,
          },
        ],
      });
      await vi.waitFor(() =>
        expect(client.localQueryResultByToken(queryToken)).toBe(0),
      );
      const counter = makeFunctionReference<
        "query",
        Record<string, never>,
        number
      >("counter:get");
      const result = client.mutation(
        "counter:increment",
        {},
        {
          optimisticUpdate: (store) => {
            const value = store.getQuery(counter, {});
            if (value !== undefined) store.setQuery(counter, {}, value + 1);
          },
        },
      );
      const request = await receive();
      if (request.type !== "Mutation") throw new Error("Expected mutation");
      const reflectedValues: unknown[] = [];
      client.addOnTransitionHandler(({ reflectedMutations }) => {
        if (
          reflectedMutations.some(
            ({ requestId }) => requestId === request.requestId,
          )
        ) {
          reflectedValues.push(client.localQueryResultByToken(queryToken));
        }
      });
      const continuation = result.then((value) => {
        expect(client.localQueryResultByToken(queryToken)).toBe(1);
        expect(reflectedValues).toEqual([1]);
        return value;
      });

      send({
        type: "Transition",
        startVersion: initialVersion,
        endVersion: { ...initialVersion, ts: Long.fromNumber(10) },
        modifications: [
          {
            type: "QueryUpdated",
            queryId: add.queryId,
            value: 1,
            logLines: [],
            journal: null,
          },
        ],
      });
      // Until the response identifies the commit, the pending optimistic update
      // is still applied on top of the authoritative value.
      await vi.waitFor(() =>
        expect(client.localQueryResultByToken(queryToken)).toBe(2),
      );
      send({
        type: "MutationResponse",
        requestId: request.requestId,
        success: true,
        ts: Long.fromNumber(10),
        result: "incremented",
        logLines: [],
      });
      await expect(continuation).resolves.toBe("incremented");
      expect(client.connectionState().inflightMutations).toBe(0);
    } finally {
      await client.close();
    }
  });
});
