import { beforeEach, describe, expect, it } from "vitest";
import { createQueryBuilder, QueryBuilder, QueryPatterns } from "./QueryBuilder.js";

describe("QueryBuilder", () => {
  let queryBuilder: QueryBuilder;

  beforeEach(() => {
    queryBuilder = new QueryBuilder("TestSchema");
  });

  describe("constructor", () => {
    it("should initialize with empty options", () => {
      expect(queryBuilder).toBeDefined();
    });
  });

  describe("limit", () => {
    it("should set limit and return this", () => {
      const result = queryBuilder.limit(10);
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().limit).toBe(10);
    });
  });

  describe("offset", () => {
    it("should set offset and return this", () => {
      const result = queryBuilder.offset(20);
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().offset).toBe(20);
    });
  });

  describe("where", () => {
    it("should set where condition and return this", () => {
      const condition = { path: ["name"], operator: "Equal", valueString: "test" };
      const result = queryBuilder.where(condition);
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().where).toEqual(condition);
    });
  });

  describe("whereField", () => {
    it("should create where condition for field", () => {
      const result = queryBuilder.whereField("name", "Equal", "test");
      expect(result).toBe(queryBuilder);

      const built = queryBuilder.build();
      expect(built.where).toEqual({
        path: ["name"],
        operator: "Equal",
        valueString: "test",
      });
    });

    it("should convert non-string values to string", () => {
      queryBuilder.whereField("age", "GreaterThan", 25);
      const built = queryBuilder.build();
      expect(built.where.valueString).toBe("25");
    });
  });

  describe("whereAnd", () => {
    it("should create AND condition for single condition", () => {
      const conditions = [{ field: "name", operator: "Equal", value: "test" }];
      queryBuilder.whereAnd(conditions);

      const built = queryBuilder.build();
      expect(built.where).toEqual({
        path: ["name"],
        operator: "Equal",
        valueString: "test",
      });
    });

    it("should create AND condition for multiple conditions", () => {
      const conditions = [
        { field: "name", operator: "Equal", value: "test" },
        { field: "age", operator: "GreaterThan", value: 25 },
      ];
      queryBuilder.whereAnd(conditions);

      const built = queryBuilder.build();
      expect(built.where).toEqual({
        operator: "And",
        operands: [
          { path: ["name"], operator: "Equal", valueString: "test" },
          { path: ["age"], operator: "GreaterThan", valueString: "25" },
        ],
      });
    });
  });

  describe("whereOr", () => {
    it("should create OR condition", () => {
      const conditions = [
        { field: "name", operator: "Equal", value: "test1" },
        { field: "name", operator: "Equal", value: "test2" },
      ];
      queryBuilder.whereOr(conditions);

      const built = queryBuilder.build();
      expect(built.where).toEqual({
        operator: "Or",
        operands: [
          { path: ["name"], operator: "Equal", valueString: "test1" },
          { path: ["name"], operator: "Equal", valueString: "test2" },
        ],
      });
    });
  });

  describe("sort", () => {
    it("should set sort order and return this", () => {
      const result = queryBuilder.sort("name", "asc");
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().sort).toEqual([{ field: "name", order: "asc" }]);
    });

    it("should default to asc order", () => {
      queryBuilder.sort("name");
      expect(queryBuilder.build().sort).toEqual([{ field: "name", order: "asc" }]);
    });
  });

  describe("sortBy", () => {
    it("should set multiple sort orders", () => {
      const sorts = [
        { field: "name", order: "asc" as const },
        { field: "age", order: "desc" as const },
      ];
      const result = queryBuilder.sortBy(sorts);
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().sort).toEqual(sorts);
    });
  });

  describe("fields", () => {
    it("should set fields to return", () => {
      const result = queryBuilder.fields(["name", "age"]);
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().fields).toEqual(["name", "age"]);
    });
  });

  describe("includeVector", () => {
    it("should set includeVector flag", () => {
      const result = queryBuilder.includeVector();
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().includeVector).toBe(true);
    });
  });

  describe("includeMetadata", () => {
    it("should set includeMetadata flag", () => {
      const result = queryBuilder.includeMetadata();
      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build().includeMetadata).toBe(true);
    });
  });

  describe("buildVectorSearch", () => {
    it("should build vector search options", () => {
      queryBuilder.limit(10).offset(5);
      const options = queryBuilder.buildVectorSearch("test query", {
        concepts: ["concept1", "concept2"],
        certainty: 0.8,
      });

      expect(options.limit).toBe(10);
      expect(options.offset).toBe(5);
      expect(options.nearText).toEqual({
        concepts: ["concept1", "concept2"],
        certainty: 0.8,
      });
    });

    it("should use query as default concept", () => {
      const options = queryBuilder.buildVectorSearch("test query");
      expect(options.nearText.concepts).toEqual(["test query"]);
    });

    it("should include moveAwayFrom and moveTo options", () => {
      const options = queryBuilder.buildVectorSearch("test query", {
        moveAwayFrom: { concepts: ["bad"], force: 0.5 },
        moveTo: { concepts: ["good"], force: 0.3 },
      });

      expect(options.nearText.moveAwayFrom).toEqual({ concepts: ["bad"], force: 0.5 });
      expect(options.nearText.moveTo).toEqual({ concepts: ["good"], force: 0.3 });
    });
  });

  describe("buildBM25Search", () => {
    it("should build BM25 search options", () => {
      queryBuilder.limit(10);
      const options = queryBuilder.buildBM25Search("test query", {
        properties: ["name", "description"],
        boost: 1.5,
      });

      expect(options.limit).toBe(10);
      expect(options.bm25).toEqual({
        query: "test query",
        properties: ["name", "description"],
        boost: 1.5,
      });
    });
  });

  describe("buildHybridSearch", () => {
    it("should build hybrid search options", () => {
      queryBuilder.limit(10);
      const options = queryBuilder.buildHybridSearch("test query", {
        alpha: 0.7,
        properties: ["name"],
        vector: [0.1, 0.2, 0.3],
      });

      expect(options.limit).toBe(10);
      expect(options.hybrid).toEqual({
        query: "test query",
        alpha: 0.7,
        properties: ["name"],
        vector: [0.1, 0.2, 0.3],
      });
    });

    it("should default alpha to 0.5", () => {
      const options = queryBuilder.buildHybridSearch("test query");
      expect(options.hybrid.alpha).toBe(0.5);
    });
  });

  describe("build", () => {
    it("should return current options", () => {
      queryBuilder.limit(10).offset(5).includeVector();
      const options = queryBuilder.build();

      expect(options).toEqual({
        limit: 10,
        offset: 5,
        includeVector: true,
      });
    });
  });

  describe("reset", () => {
    it("should reset options and return this", () => {
      queryBuilder.limit(10).offset(5);
      const result = queryBuilder.reset();

      expect(result).toBe(queryBuilder);
      expect(queryBuilder.build()).toEqual({});
    });
  });

  describe("clone", () => {
    it("should create a copy with same options", () => {
      queryBuilder.limit(10).offset(5);
      const cloned = queryBuilder.clone();

      expect(cloned).not.toBe(queryBuilder);
      expect(cloned.build()).toEqual({ limit: 10, offset: 5 });
    });

    it("should allow independent modification", () => {
      queryBuilder.limit(10);
      const cloned = queryBuilder.clone();

      cloned.offset(5);
      expect(queryBuilder.build()).toEqual({ limit: 10 });
      expect(cloned.build()).toEqual({ limit: 10, offset: 5 });
    });
  });
});

describe("createQueryBuilder", () => {
  it("should create new QueryBuilder instance", () => {
    const builder = createQueryBuilder("TestSchema");
    expect(builder).toBeInstanceOf(QueryBuilder);
  });
});

describe("QueryPatterns", () => {
  describe("dateRange", () => {
    it("should create date range query", () => {
      const startDate = new Date("2023-01-01");
      const endDate = new Date("2023-12-31");
      const builder = QueryPatterns.dateRange("createdAt", startDate, endDate);

      const options = builder.build();
      expect(options.where).toEqual({
        operator: "And",
        operands: [
          {
            path: ["createdAt"],
            operator: "GreaterThanEqual",
            valueString: startDate.toISOString(),
          },
          { path: ["createdAt"], operator: "LessThanEqual", valueString: endDate.toISOString() },
        ],
      });
    });
  });

  describe("textContains", () => {
    it("should create text contains query", () => {
      const builder = QueryPatterns.textContains("name", "test");
      const options = builder.build();

      expect(options.where).toEqual({
        path: ["name"],
        operator: "Like",
        valueString: "*test*",
      });
    });
  });

  describe("exactMatch", () => {
    it("should create exact match query", () => {
      const builder = QueryPatterns.exactMatch("status", "active");
      const options = builder.build();

      expect(options.where).toEqual({
        path: ["status"],
        operator: "Equal",
        valueString: "active",
      });
    });
  });

  describe("inValues", () => {
    it("should create in values query", () => {
      const builder = QueryPatterns.inValues("category", ["tech", "business"]);
      const options = builder.build();

      expect(options.where).toEqual({
        path: ["category"],
        operator: "ContainsAny",
        valueString: ["tech", "business"],
      });
    });
  });

  describe("isNull", () => {
    it("should create is null query", () => {
      const builder = QueryPatterns.isNull("deletedAt", true);
      const options = builder.build();

      expect(options.where).toEqual({
        path: ["deletedAt"],
        operator: "IsNull",
        valueString: true,
      });
    });

    it("should create is not null query", () => {
      const builder = QueryPatterns.isNull("deletedAt", false);
      const options = builder.build();

      expect(options.where).toEqual({
        path: ["deletedAt"],
        operator: "IsNull",
        valueString: false,
      });
    });
  });

  describe("numericRange", () => {
    it("should create numeric range with min and max", () => {
      const builder = QueryPatterns.numericRange("age", 18, 65);
      const options = builder.build();

      expect(options.where).toEqual({
        operator: "And",
        operands: [
          { path: ["age"], operator: "GreaterThanEqual", valueString: "18" },
          { path: ["age"], operator: "LessThanEqual", valueString: "65" },
        ],
      });
    });

    it("should create numeric range with only min", () => {
      const builder = QueryPatterns.numericRange("age", 18);
      const options = builder.build();

      expect(options.where).toEqual({
        path: ["age"],
        operator: "GreaterThanEqual",
        valueString: "18",
      });
    });

    it("should create numeric range with only max", () => {
      const builder = QueryPatterns.numericRange("age", undefined, 65);
      const options = builder.build();

      expect(options.where).toEqual({
        path: ["age"],
        operator: "LessThanEqual",
        valueString: "65",
      });
    });

    it("should return empty builder when no range specified", () => {
      const builder = QueryPatterns.numericRange("age");
      const options = builder.build();

      expect(options.where).toBeUndefined();
    });
  });
});
