/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { makeFunctionReference } from "../server/index.js";
import { usePaginatedQuery } from "./use_paginated_query.js";
import { usePaginatedQuery_experimental } from "./use_paginated_query2.js";

const query = makeFunctionReference<"query">("messages:list") as any;

test("usePaginatedQuery names itself when there is no ConvexProvider", () => {
  expect(() =>
    renderHook(() => usePaginatedQuery(query, {}, { initialNumItems: 1 })),
  ).toThrow("Could not find Convex client! `usePaginatedQuery`");
});

test("usePaginatedQuery_experimental names itself when there is no ConvexProvider", () => {
  expect(() =>
    renderHook(() =>
      usePaginatedQuery_experimental(query, {}, { initialNumItems: 1 }),
    ),
  ).toThrow("Could not find Convex client! `usePaginatedQuery_experimental`");
});
