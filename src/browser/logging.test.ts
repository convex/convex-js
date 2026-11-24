import { afterEach, expect, test, vi } from "vitest";
import { ConvexHttpClient } from "./http_client.js";
import { DefaultLogger } from "./logging.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("constructing a ConvexHttpClient doesn't call Math.random()", () => {
  const random = vi.spyOn(Math, "random");
  new ConvexHttpClient("https://example-123.convex.cloud");
  expect(random).not.toHaveBeenCalled();
});

test("log line listeners can be removed independently", () => {
  const logger = new DefaultLogger({ verbose: false });
  const first = vi.fn();
  const second = vi.fn();
  const removeFirst = logger.addLogLineListener(first);
  logger.addLogLineListener(second);

  logger.log("one");
  removeFirst();
  logger.log("two");

  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(2);
});
