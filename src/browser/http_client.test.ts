import { describe, expect, it } from "vitest";
import { makeFunctionReference } from "../server/index.js";
import { ConvexError } from "../values/index.js";
import { ConvexHttpClient } from "./http_client.js";

const functionPath = "messages:list";
const errorMessage = "[Request ID: test-request] Server Error";
const errorData = { code: "INVALID_MESSAGE", detail: "Message is invalid" };

function clientWithErrorResponse(
  response: Record<string, unknown>,
): ConvexHttpClient {
  return new ConvexHttpClient("https://test.convex.cloud", {
    fetch: async () =>
      new Response(JSON.stringify(response), {
        status: 560,
        headers: { "Content-Type": "application/json" },
      }),
    logger: false,
  });
}

const functionCalls = [
  {
    type: "query",
    prefix: "Q",
    invoke: (client: ConvexHttpClient) =>
      client.query(makeFunctionReference<"query">(functionPath), {}),
  },
  {
    type: "mutation",
    prefix: "M",
    invoke: (client: ConvexHttpClient) =>
      client.mutation(makeFunctionReference<"mutation">(functionPath), {}),
  },
  {
    type: "action",
    prefix: "A",
    invoke: (client: ConvexHttpClient) =>
      client.action(makeFunctionReference<"action">(functionPath), {}),
  },
];

describe.each(functionCalls)("$type errors", ({ prefix, invoke }) => {
  const expectedMessage = `[CONVEX ${prefix}(${functionPath})] ${errorMessage}\n  Called by client`;

  it("includes the failed function in the error message", async () => {
    const client = clientWithErrorResponse({
      status: "error",
      errorMessage,
    });

    await expect(invoke(client)).rejects.toMatchObject({
      message: expectedMessage,
    });
  });

  it("preserves ConvexError identity and application error data", async () => {
    const client = clientWithErrorResponse({
      status: "error",
      errorMessage,
      errorData,
    });
    const call = invoke(client);

    await expect(call).rejects.toBeInstanceOf(ConvexError);
    await expect(call).rejects.toMatchObject({
      message: expectedMessage,
      data: errorData,
    });
  });
});
