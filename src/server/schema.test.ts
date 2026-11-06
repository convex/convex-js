import { describe, expect, test } from "vitest";
import { type Infer, v } from "../values/index.js";
import type { DocumentByName } from "./data_model.js";
import {
  type DataModelFromSchemaDefinition,
  defineSchema,
  defineTable,
} from "./schema.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const innerResult = v.union(
  v.object({ kind: v.literal("success"), value: v.string() }),
  v.object({ kind: v.literal("error"), message: v.string() }),
);

const schema = defineSchema({
  results: defineTable(
    v.union(
      innerResult,
      v.object({ kind: v.literal("pending"), startedAt: v.number() }),
    ),
  ),
});

type ResultDoc = Infer<ReturnType<typeof schema.doc<"results">>>;
type GeneratedResultDoc = DocumentByName<
  DataModelFromSchemaDefinition<typeof schema>,
  "results"
>;
type ResultDocMatchesGeneratedDataModel = Expect<
  Equal<ResultDoc, GeneratedResultDoc>
>;

describe("schema.doc", () => {
  test("adds system fields to objects in nested unions", () => {
    const resultDoc = schema.doc("results");

    expect(resultDoc.kind).toBe("union");
    expect(resultDoc.members[0].kind).toBe("union");
    for (const member of resultDoc.members[0].members) {
      expect(member.kind).toBe("object");
      expect(Object.keys(member.fields)).toEqual(
        expect.arrayContaining(["_id", "_creationTime"]),
      );
    }
  });
});

void (false as ResultDocMatchesGeneratedDataModel);
