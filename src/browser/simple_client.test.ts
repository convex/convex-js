import { describe, expect, test, vi } from "vitest";
import {
  fakeServer,
  pageUpdated,
  queryFailed,
  queryUpdated,
  withInMemoryWebSocket,
} from "./sync/client_node_test_helpers.js";
import { makeFunctionReference } from "../server/index.js";
// This Node.js build sets up the WebSocket dependency automatically.
import { ConvexClient } from "./simple_client-node.js";

const listQuery = makeFunctionReference<"query">("messages:list");
const countQuery = makeFunctionReference<
  "query",
  Record<string, never>,
  number
>("messages:count");

const pageFailed = expect.stringContaining("Page failed");

describe("onPaginatedUpdate_experimental with a failed page", () => {
  test("calls onError and keeps other subscriptions updating", async () => {
    await withInMemoryWebSocket(async (socket) => {
      const server = fakeServer(socket);
      const client = new ConvexClient(socket.address, {
        unsavedChangesWarning: false,
      });
      expect((await socket.receive()).type).toEqual("Connect");
      await server.added();

      const errors: string[] = [];
      const list = client.onPaginatedUpdate_experimental(
        listQuery,
        {},
        { initialNumItems: 2 },
        () => {},
        (error) => errors.push(error.message),
      );
      const [firstPage] = await server.added();
      const counts: number[] = [];
      client.onUpdate(countQuery, {}, (count) => counts.push(count));
      const [count] = await server.added();

      server.transition(
        pageUpdated(firstPage.queryId, ["a", "b"]),
        queryUpdated(count.queryId, 2),
      );
      await vi.waitFor(() => expect(counts).toEqual([2]));
      expect(list.getCurrentValue()?.results).toEqual(["a", "b"]);

      server.transition(
        queryFailed(firstPage.queryId, "Page failed"),
        queryUpdated(count.queryId, 3),
      );
      await vi.waitFor(() => expect(errors).toEqual([pageFailed]));
      expect(counts).toEqual([2, 3]);

      // A later transition reaches the other subscription and does not report
      // the failure again.
      server.transition(queryUpdated(count.queryId, 4));
      await vi.waitFor(() => expect(counts).toEqual([2, 3, 4]));
      expect(errors).toHaveLength(1);

      // The next result for the page replaces the failure.
      server.transition(pageUpdated(firstPage.queryId, ["c", "d"]));
      await vi.waitFor(() =>
        expect(list.getCurrentValue()?.results).toEqual(["c", "d"]),
      );
      expect(errors).toHaveLength(1);

      await client.close();
    });
  });

  test("reports the failure to a later subscriber of the same query", async () => {
    await withInMemoryWebSocket(async (socket) => {
      const server = fakeServer(socket);
      const client = new ConvexClient(socket.address, {
        unsavedChangesWarning: false,
      });
      expect((await socket.receive()).type).toEqual("Connect");
      await server.added();

      const firstErrors: string[] = [];
      client.onPaginatedUpdate_experimental(
        listQuery,
        {},
        { initialNumItems: 2 },
        () => {},
        (error) => firstErrors.push(error.message),
      );
      const [firstPage] = await server.added();
      server.transition(queryFailed(firstPage.queryId, "Page failed"));
      await vi.waitFor(() => expect(firstErrors).toEqual([pageFailed]));

      const laterErrors: string[] = [];
      const later = client.onPaginatedUpdate_experimental(
        listQuery,
        {},
        { initialNumItems: 2 },
        () => laterErrors.push("unexpected result"),
        (error) => laterErrors.push(error.message),
      );
      await vi.waitFor(() => expect(laterErrors).toEqual([pageFailed]));
      expect(() => later.getCurrentValue()).toThrow("Page failed");
      expect(firstErrors).toHaveLength(1);

      await client.close();
    });
  });

  test.each([
    ["first", 0],
    ["second", 1],
  ])(
    "calls onError when the %s split page fails while the other loads",
    async (_name, failedHalf) => {
      await withInMemoryWebSocket(async (socket) => {
        const server = fakeServer(socket);
        const client = new ConvexClient(socket.address, {
          unsavedChangesWarning: false,
        });
        expect((await socket.receive()).type).toEqual("Connect");
        await server.added();

        const errors: string[] = [];
        const list = client.onPaginatedUpdate_experimental(
          listQuery,
          {},
          { initialNumItems: 2 },
          () => {},
          (error) => errors.push(error.message),
        );
        const [firstPage] = await server.added();

        server.transition(
          pageUpdated(firstPage.queryId, ["a", "b", "c", "d"], {
            splitCursor: "b",
            pageStatus: "SplitRequired",
          }),
        );
        // The client subscribes to each half separately.
        const halves = [...(await server.added()), ...(await server.added())];
        expect(halves).toHaveLength(2);
        expect(list.getCurrentValue()?.results).toEqual(["a", "b", "c", "d"]);

        server.transition(
          queryFailed(halves[failedHalf].queryId, "Page failed"),
        );
        await vi.waitFor(() => expect(errors).toEqual([pageFailed]));
        expect(() => list.getCurrentValue()).toThrow("Page failed");

        await client.close();
      });
    },
  );
});
