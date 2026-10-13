/**
 * Configuration interface for Weaviate searchable fields
 *
 * @example
 * ```typescript
 * // High-priority search field
 * {
 *   name: "fullName",
 *   dataType: ["string"],
 *   description: "Full name of the person",
 *   indexInverted: true,
 *   indexSearchable: true,
 *   weight: 2.0,
 *   boost: 1.5
 * }
 *
 * // Filter-only field
 * {
 *   name: "city",
 *   dataType: ["string"],
 *   description: "City of residence",
 *   indexInverted: true,
 *   indexFilterable: true,
 *   weight: 0.5
 * }
 * ```
 */
export interface SearchableField {
  /** The name of the field in the Weaviate schema */
  name: string;

  /** Array of data types that this field can contain (e.g., ['string', 'text']) */
  dataType: string[];

  /** Optional human-readable description of what this field represents */
  description?: string;

  /**
   * Whether to create an inverted index for this field (enables full-text search)
   * @default true
   */
  indexInverted?: boolean;

  /**
   * Whether this field can be used in filter operations (WHERE clauses)
   * @default true
   */
  indexFilterable?: boolean;

  /**
   * Whether this field is included in search operations and can be searched against
   * @default true
   */
  indexSearchable?: boolean;

  /**
   * Weight for BM25 scoring algorithm - higher values make this field more important in text search relevance
   * @default 1.0
   * @example
   * - 2.0: High importance (names, titles)
   * - 1.5: Medium-high importance (normalized names)
   * - 1.0: Normal importance (descriptions, bios)
   * - 0.5: Low importance (metadata, locations)
   * - 0.3: Very low importance (codes, IDs)
   */
  weight?: number;

  /**
   * Boost factor for vector search - multiplies the similarity score for this field in vector-based searches
   * @default 1.0
   * @example
   * - 1.5: High vector search boost (primary search fields)
   * - 1.2: Medium vector search boost (secondary fields)
   * - 1.0: No boost (default)
   */
  boost?: number;

  /**
   * Tokenization method for text fields in Weaviate
   * @example
   * - "field": Tokenize the entire field as a single token
   * - "word": Tokenize by words (default)
   * - "lowercase": Convert to lowercase before tokenization
   * - "whitespace": Split on whitespace
   */
  tokenization?: "field" | "word" | "lowercase" | "whitespace";
}
