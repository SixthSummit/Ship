import type {
  BM25SearchOptions,
  HybridSearchOptions,
  SearchOptions,
  VectorSearchOptions,
} from "./types/index.js";

export class QueryBuilder {
  private options: SearchOptions = {};

  constructor(_schemaName: string) {
    this.options = {};
  }

  /**
   * Set query limit
   */
  limit(count: number): this {
    this.options.limit = count;
    return this;
  }

  /**
   * Set query offset
   */
  offset(count: number): this {
    this.options.offset = count;
    return this;
  }

  /**
   * Add where clause
   */
  where(condition: Record<string, any>): this {
    this.options.where = condition;
    return this;
  }

  /**
   * Add field-based where clause
   */
  whereField(field: string, operator: string, value: any): this {
    this.options.where = {
      path: [field],
      operator,
      valueString: typeof value === "string" ? value : String(value),
    };
    return this;
  }

  /**
   * Add multiple where conditions
   */
  whereAnd(conditions: Array<{ field: string; operator: string; value: any }>): this {
    if (conditions.length === 1) {
      return this.whereField(conditions[0].field, conditions[0].operator, conditions[0].value);
    }

    this.options.where = {
      operator: "And",
      operands: conditions.map((cond) => ({
        path: [cond.field],
        operator: cond.operator,
        valueString: typeof cond.value === "string" ? cond.value : String(cond.value),
      })),
    };
    return this;
  }

  /**
   * Add OR where conditions
   */
  whereOr(conditions: Array<{ field: string; operator: string; value: any }>): this {
    this.options.where = {
      operator: "Or",
      operands: conditions.map((cond) => ({
        path: [cond.field],
        operator: cond.operator,
        valueString: typeof cond.value === "string" ? cond.value : String(cond.value),
      })),
    };
    return this;
  }

  /**
   * Add sort order
   */
  sort(field: string, order: "asc" | "desc" = "asc"): this {
    this.options.sort = [{ field, order }];
    return this;
  }

  /**
   * Add multiple sort orders
   */
  sortBy(sorts: Array<{ field: string; order: "asc" | "desc" }>): this {
    this.options.sort = sorts;
    return this;
  }

  /**
   * Specify fields to return
   */
  fields(fieldNames: string[]): this {
    this.options.fields = fieldNames;
    return this;
  }

  /**
   * Include vector in results
   */
  includeVector(): this {
    this.options.includeVector = true;
    return this;
  }

  /**
   * Include metadata in results
   */
  includeMetadata(): this {
    this.options.includeMetadata = true;
    return this;
  }

  /**
   * Build vector search options
   */
  buildVectorSearch(
    query: string,
    options: {
      concepts?: string[];
      certainty?: number;
      moveAwayFrom?: { concepts: string[]; force: number };
      moveTo?: { concepts: string[]; force: number };
    } = {},
  ): VectorSearchOptions {
    return {
      ...this.options,
      nearText: {
        concepts: options.concepts || [query],
        certainty: options.certainty,
        moveAwayFrom: options.moveAwayFrom,
        moveTo: options.moveTo,
      },
    };
  }

  /**
   * Build BM25 search options
   */
  buildBM25Search(
    query: string,
    options: {
      properties?: string[];
      boost?: number;
    } = {},
  ): BM25SearchOptions {
    return {
      ...this.options,
      bm25: {
        query,
        properties: options.properties,
        boost: options.boost,
      },
    };
  }

  /**
   * Build hybrid search options
   */
  buildHybridSearch(
    query: string,
    options: {
      alpha?: number;
      properties?: string[];
      vector?: number[];
    } = {},
  ): HybridSearchOptions {
    return {
      ...this.options,
      hybrid: {
        query,
        alpha: options.alpha || 0.5,
        properties: options.properties,
        vector: options.vector,
      },
    };
  }

  /**
   * Build basic search options
   */
  build(): SearchOptions {
    return { ...this.options };
  }

  /**
   * Reset builder
   */
  reset(): this {
    this.options = {};
    return this;
  }

  /**
   * Clone builder
   */
  clone(): QueryBuilder {
    const cloned = new QueryBuilder("");
    cloned.options = { ...this.options };
    return cloned;
  }
}

/**
 * Factory function for creating query builders
 */
export function createQueryBuilder(schemaName: string): QueryBuilder {
  return new QueryBuilder(schemaName);
}

/**
 * Common query patterns
 */
export class QueryPatterns {
  /**
   * Search by date range
   */
  static dateRange(field: string, startDate: Date, endDate: Date): QueryBuilder {
    return createQueryBuilder("").whereAnd([
      { field, operator: "GreaterThanEqual", value: startDate.toISOString() },
      { field, operator: "LessThanEqual", value: endDate.toISOString() },
    ]);
  }

  /**
   * Search by text contains
   */
  static textContains(field: string, text: string): QueryBuilder {
    return createQueryBuilder("").whereField(field, "Like", `*${text}*`);
  }

  /**
   * Search by exact match
   */
  static exactMatch(field: string, value: any): QueryBuilder {
    return createQueryBuilder("").whereField(field, "Equal", value);
  }

  /**
   * Search by multiple values
   */
  static inValues(field: string, values: any[]): QueryBuilder {
    return createQueryBuilder("").where({
      path: [field],
      operator: "ContainsAny",
      valueString: values.map((v) => String(v)),
    });
  }

  /**
   * Search by null/not null
   */
  static isNull(field: string, isNull: boolean = true): QueryBuilder {
    return createQueryBuilder("").where({
      path: [field],
      operator: "IsNull",
      valueString: isNull,
    });
  }

  /**
   * Search by numeric range
   */
  static numericRange(field: string, min?: number, max?: number): QueryBuilder {
    const conditions: Array<{ field: string; operator: string; value: any }> = [];

    if (min !== undefined) {
      conditions.push({ field, operator: "GreaterThanEqual", value: min });
    }

    if (max !== undefined) {
      conditions.push({ field, operator: "LessThanEqual", value: max });
    }

    if (conditions.length === 0) {
      return createQueryBuilder("");
    }

    return createQueryBuilder("").whereAnd(conditions);
  }
}
