import { Base64, JSONValue } from "../../values/index.js";
import { Long } from "../../vendor/long.js";

// --experimental-vm-modules which we use for jest doesn't support named exports
import WebSocket, { WebSocketServer } from "ws";

// Let's pretend this ws WebSocket is a browser WebSocket (it's very close)
export const nodeWebSocket = WebSocket as unknown as typeof window.WebSocket;

import {
  AddQuery,
  ClientMessage,
  Transition,
  WireServerMessage,
} from "./protocol.js";
import {
  PaginatedQueryToken,
  QueryToken,
  serializedQueryTokenIsPaginated,
} from "./udf_path_utils.js";
import { BaseConvexClient } from "./client.js";
import { PaginatedQueryClient } from "./paginated_query_client.js";

export type InMemoryWebSocketTest = (args: {
  address: string;
  socket: () => WebSocket;
  receive: () => Promise<ClientMessage>;
  send: (message: WireServerMessage) => void;
  close: () => void;
}) => Promise<void>;

function listeningSocketServer(): Promise<WebSocketServer> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("listening", () => resolve(wss));
  });
}

// Run a test with a real node WebSocket instance connected
export async function withInMemoryWebSocket(
  cb: InMemoryWebSocketTest,
  debug = false,
) {
  // These state variables are consistent over multiple sockets.
  let received: (msg: string) => void;
  // prettier-ignore
  const messages: Promise<string>[] = [ new Promise((r) => { received = r; }) ];
  let socket: WebSocket | null = null;

  const wss = await listeningSocketServer();

  const setUpSocket = () => {
    wss.once("connection", function connection(ws: WebSocket) {
      socket = ws;
      ws.on("message", function message(data: string) {
        received(data);
        // eslint-disable-next-line no-console
        if (debug) console.debug(`client --${JSON.parse(data).type}--> `);
        messages.push(
          new Promise((r) => {
            received = r;
          }),
        );
      });
    });
  };
  setUpSocket();

  // receive and send are stable across multiple socket connections
  async function receive(): Promise<ClientMessage> {
    const msgP = messages.shift();
    if (!msgP) {
      throw new Error("Receive() called twice? No message promise found.");
    }
    const text = await msgP;
    const structured = JSON.parse(text);
    return structured;
  }
  function send(message: WireServerMessage) {
    // eslint-disable-next-line no-console
    if (debug) console.debug(`      <--${message.type}-- server`);
    socket!.send(encodeServerMessage(message));
  }

  const s: any = wss.address();
  const address = typeof s === "string" ? s : `http://127.0.0.1:${s.port}`;

  try {
    await cb({
      address,
      socket: () => socket as unknown as WebSocket,
      receive,
      send,
      close: () => {
        // eslint-disable-next-line no-console
        if (debug) console.debug(`           --CLOSE-->8-- server`);
        socket!.close();
        setUpSocket();
      },
    });
  } finally {
    const s = socket!;
    if (s!) {
      socket!.close();
    }
    wss.close();
  }
}

export function encodeServerMessage(message: WireServerMessage): string {
  function replacer(_key: string, value: any) {
    if (Long.isLong(value)) {
      return encodeLong(value);
    }
    return value;
  }
  return JSON.stringify(message, replacer);
}

function encodeLong(n: Long) {
  const integerBytes = Uint8Array.from(n.toBytesLE());
  return Base64.fromByteArray(integerBytes);
}

/**
 * const q = new UpdateQueue();
 * const client = new BaseConvexClient(address, queryTokens => { q.onTransition(client)(queryTokens) });
 *
 * await q.updatePromises[3];
 *
 */
export class UpdateQueue {
  updateResolves: ((v: Record<QueryToken, any>) => void)[];
  updatePromises: Promise<Record<QueryToken, any>>[];
  updates: Record<QueryToken, any>[];
  allResults: Record<QueryToken, any>;
  nextIndex: number;

  constructor(maxLength = 10) {
    this.updateResolves = [];
    this.updatePromises = [];
    this.allResults = {};
    this.updates = [];
    this.nextIndex = 0;

    let nextResolve: (v: Record<QueryToken, any>) => void;
    let nextPromise: Promise<Record<QueryToken, any>>;

    for (let i = 0; i < maxLength; i++) {
      nextPromise = new Promise((r) => {
        nextResolve = r;
      });
      this.updateResolves.push(nextResolve!);
      this.updatePromises.push(nextPromise);
    }
  }

  /**
   * Useful to use instead of directly awaiting so that the timeout has a line number
   * unlike the default Vite test timeout.
   */
  async awaitPromiseAtIndexWithTimeout(
    i: number,
  ): Promise<Record<QueryToken | PaginatedQueryToken, any>> {
    if (!this.updatePromises[i]) {
      throw new Error("That promise doesn't exist yet");
    }
    const inBandSignal = "UpdateQueue await timed out";
    const result = await Promise.race([
      new Promise((r) => setTimeout(() => r(inBandSignal), 1000)),
      this.updatePromises[i],
    ]);
    if (result === inBandSignal) {
      throw new Error("Awaiting promise in UpdateQueue");
    }
    // cast from the updatePromises where this was any, but know it's unknown
    return result as any;
  }

  onTransition =
    (client: BaseConvexClient, paginatedClient?: PaginatedQueryClient) =>
    (updatedQueryTokens: (QueryToken | PaginatedQueryToken)[]) => {
      const update: Record<QueryToken, any> = {};
      for (const queryToken of updatedQueryTokens) {
        if (serializedQueryTokenIsPaginated(queryToken)) {
          if (!paginatedClient) {
            throw new Error(
              "No PaginatedQueryClient provided to look up value for token " +
                queryToken,
            );
          }
          const value = paginatedClient?.localQueryResultByToken(queryToken);
          update[queryToken] = value;
          this.allResults[queryToken] = value;
        } else {
          const value = client.localQueryResultByToken(queryToken);
          update[queryToken] = value;
          this.allResults[queryToken] = value;
        }
      }
      this.updateResolves[this.nextIndex](update);
      this.updates.push(update);
      this.nextIndex++;
    };
}

type StateModification = Transition["modifications"][number];

/**
 * Plays the server over a {@link withInMemoryWebSocket} socket: reads the
 * client's query set changes and sends transitions with matching versions.
 */
export function fakeServer({
  receive,
  send,
}: Pick<Parameters<InMemoryWebSocketTest>[0], "receive" | "send">) {
  let querySet = 0;
  let sentQuerySet = 0;
  let ts = 0;
  return {
    /** Waits for the client's next query set change and returns its adds. */
    async added(): Promise<AddQuery[]> {
      const message = await receive();
      if (message.type !== "ModifyQuerySet") {
        throw new Error(`Expected ModifyQuerySet, got ${message.type}`);
      }
      querySet = message.newVersion;
      return message.modifications.filter(
        (modification): modification is AddQuery => modification.type === "Add",
      );
    },
    transition(...modifications: StateModification[]) {
      send({
        type: "Transition",
        startVersion: {
          querySet: sentQuerySet,
          identity: 0,
          ts: Long.fromNumber(ts),
        },
        endVersion: { querySet, identity: 0, ts: Long.fromNumber(++ts) },
        modifications,
      });
      sentQuerySet = querySet;
    },
  };
}

export function queryUpdated(
  queryId: number,
  value: JSONValue,
): StateModification {
  return { type: "QueryUpdated", queryId, value, logLines: [], journal: null };
}

export function pageUpdated(
  queryId: number,
  rows: string[],
  split: { splitCursor: string; pageStatus: "SplitRequired" } | null = null,
): StateModification {
  return queryUpdated(queryId, {
    page: rows,
    isDone: false,
    continueCursor: "end",
    splitCursor: split?.splitCursor ?? null,
    pageStatus: split?.pageStatus ?? null,
  });
}

export function queryFailed(
  queryId: number,
  errorMessage: string,
): StateModification {
  return {
    type: "QueryFailed",
    queryId,
    errorMessage,
    errorData: null,
    logLines: [],
    journal: null,
  };
}
