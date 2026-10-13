import type { MultiTenancyConfig } from "./MultiTenancy.js";
import type { SearchableField } from "./SearchableField.js";
import type { VectorIndexConfig } from "./VectorIndexConfig.js";
import type { Vectorizer } from "./VectorizerConfig.js";

export interface SchemaConfig {
  name: string;
  description?: string;
  vectorizer?: Vectorizer;
  vectorIndexConfig?: VectorIndexConfig;
  properties: SearchableField[];
  searchableFields?: string[]; // Fields to include in search by default
  filterableFields?: string[]; // Fields that can be used in where clauses
  sortableFields?: string[]; // Fields that can be used for sorting
  relationships?: {
    [fieldName: string]: {
      targetClass: string;
      type: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
      required?: boolean;
    };
  };
  plugins?: string[]; // Custom plugin names to apply
  metadata?: Record<string, any>; // Additional metadata
  multiTenancy?: MultiTenancyConfig; // Multi-tenancy configuration
}
