export {
  build{{NamePlural}}App,
  define{{NamePlural}}Routes,
  type {{NamePlural}}RoutesDeps,
} from "./routes.js";

export { {{NameSingular}}Service } from "./services/{{NameSingular}}Service.js";

export {
  {{NAME_PLURAL}}_PERMISSIONS,
  {{NAME_PLURAL}}_PERMISSION_DEFINITIONS,
  type {{NamePlural}}Permission,
} from "./permissions.js";

export {
  create{{NameSingular}}Schema,
  update{{NameSingular}}Schema,
  {{nameSingular}}IdParamSchema,
  list{{NamePlural}}QuerySchema,
  type Create{{NameSingular}}Input,
  type Update{{NameSingular}}Input,
  type {{NameSingular}}IdParam,
  type List{{NamePlural}}Query,
} from "./validation/schemas.js";

export {
  {{nameCamelPlural}},
  type {{NameSingular}},
  type New{{NameSingular}},
} from "./schema.js";
