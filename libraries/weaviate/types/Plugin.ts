import type { SearchResult } from "./SearchResult.js";

export interface Plugin {
  name: string;
  version: string;
  description: string;
  hooks: {
    beforeSearch?: (className: string, options: any) => any;
    afterSearch?: (className: string, result: SearchResult) => SearchResult;
    beforeCreate?: (className: string, data: any) => any;
    afterCreate?: (className: string, result: any) => any;
    beforeUpdate?: (className: string, id: string, data: any) => any;
    afterUpdate?: (className: string, result: any) => any;
    beforeDelete?: (className: string, id: string) => any;
    afterDelete?: (className: string, result: any) => any;
  };
}
