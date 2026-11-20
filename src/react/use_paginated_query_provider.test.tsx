import React from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { makeFunctionReference } from "../server/index.js";
import { usePaginatedQuery } from "./use_paginated_query.js";
import { usePaginatedQuery_experimental } from "./use_paginated_query2.js";

const query = makeFunctionReference<"query">("messages:list") as any;
const options = { initialNumItems: 1 };

// Renders a component that calls `hook` with no `ConvexProvider` above it.
function render(hook: () => unknown) {
  function Component() {
    hook();
    return null;
  }
  return () => renderToString(<Component />);
}

function missingProvider(hook: string) {
  return new Error(
    `Could not find Convex client! \`${hook}\` must be used in the React component ` +
      "tree under `ConvexProvider`. Did you forget it? " +
      "See https://docs.convex.dev/quick-start#set-up-convex-in-your-react-app",
  );
}

test.each([{}, "skip"] as const)(
  "usePaginatedQuery names itself when there is no ConvexProvider (args: %j)",
  (args) => {
    expect(render(() => usePaginatedQuery(query, args, options))).toThrow(
      missingProvider("usePaginatedQuery"),
    );
  },
);

test.each([{}, "skip"] as const)(
  "usePaginatedQuery_experimental names itself when there is no ConvexProvider (args: %j)",
  (args) => {
    const error = missingProvider("usePaginatedQuery_experimental");
    expect(
      render(() => usePaginatedQuery_experimental(query, args, options)),
    ).toThrow(error);
    expect(
      render(() => usePaginatedQuery_experimental({ query, args, ...options })),
    ).toThrow(error);
  },
);
