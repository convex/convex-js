/**
 * @vitest-environment custom-vitest-environment.ts
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { anyApi } from "../server/api.js";
import { Value } from "../values/index.js";
import { CreateWatch } from "./queries_observer.js";
import { useQueriesHelper } from "./use_queries.js";

function fakeWatches() {
  const listeners = new Set<() => void>();
  const results: Record<string, Value | undefined> = {};
  const createWatch: CreateWatch = (_query, args) => ({
    onUpdate: (callback: () => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    localQueryResult: () => results[args.key as string],
    localQueryLogs: () => undefined,
    journal: () => undefined,
  });
  const notify = () =>
    act(() => {
      listeners.forEach((listener) => listener());
    });
  return { createWatch, results, notify };
}

test("useQueries returns the same object when no result changed", () => {
  const { createWatch, results, notify } = fakeWatches();
  results.a = { name: "a" };
  const queries = {
    a: { query: anyApi.messages.list, args: { key: "a" } },
  };

  let renders = 0;
  const result: { current: Record<string, any> } = { current: {} };
  function Reader() {
    renders++;
    result.current = useQueriesHelper(queries, createWatch);
    return null;
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Reader)));
  const first = result.current;
  const rendersBefore = renders;

  // A transition that didn't change this query's result, such as an
  // optimistic update replay for another query.
  notify();
  expect(result.current).toBe(first);
  expect(renders).toBe(rendersBefore);

  results.a = { name: "a, edited" };
  notify();
  expect(result.current).not.toBe(first);
  expect(result.current.a).toEqual({ name: "a, edited" });
  act(() => root.unmount());
});
