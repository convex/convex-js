import { expect, test, vi } from "vitest";
import {
  fakeServer,
  nodeWebSocket,
  pageUpdated,
  queryFailed,
  queryUpdated,
  withInMemoryWebSocket,
} from "../browser/sync/client_node_test_helpers.js";
import { makeFunctionReference } from "../server/index.js";
import { ConvexReactClient } from "./client.js";

const listQuery = makeFunctionReference<"query">("messages:list");
const countQuery = makeFunctionReference<
  "query",
  Record<string, never>,
  number
>("messages:count");

test("a failed page does not stop other queries from updating", async () => {
  await withInMemoryWebSocket(async (socket) => {
    const server = fakeServer(socket);
    const client = new ConvexReactClient(socket.address, {
      webSocketConstructor: nodeWebSocket,
      unsavedChangesWarning: false,
    });

    const counts: (number | undefined)[] = [];
    const countWatch = client.watchQuery(countQuery, {});
    countWatch.onUpdate(() => counts.push(countWatch.localQueryResult()));
    expect((await socket.receive()).type).toEqual("Connect");
    const [count] = await server.added();

    const listWatch = client.watchPaginatedQuery(
      listQuery,
      {},
      { initialNumItems: 2, id: 0 },
    );
    listWatch.onUpdate(() => {});
    const [firstPage] = await server.added();

    server.transition(
      pageUpdated(firstPage.queryId, ["a", "b"]),
      queryUpdated(count.queryId, 2),
    );
    await vi.waitFor(() => expect(counts).toEqual([2]));

    server.transition(
      queryFailed(firstPage.queryId, "Page failed"),
      queryUpdated(count.queryId, 3),
    );
    await vi.waitFor(() => expect(counts).toEqual([2, 3]));
    expect(() => listWatch.localQueryResult()).toThrow("Page failed");

    server.transition(queryUpdated(count.queryId, 4));
    await vi.waitFor(() => expect(counts).toEqual([2, 3, 4]));

    await client.close();
  });
});
