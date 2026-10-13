/**
 * Accounts module — public barrel.
 *
 * Default account / role / permission CRUD over the module's own identity
 * tables. Consumers wire it via `defineAccountsRoutes(app, { service, provider })`.
 */

export {
  ACCOUNTS_PERMISSION_DEFINITIONS,
  ACCOUNTS_PERMISSIONS,
  type AccountsPermission,
} from "./permissions.js";
export { type AccountsRoutesDeps, buildAccountsApp, defineAccountsRoutes } from "./routes.js";
export {
  type Account,
  accounts,
  accountsRelations,
  accountsSchema,
  type NewAccount,
  type NewPermission,
  type NewRole,
  type NewRolePermission,
  type NewTenant,
  type Permission,
  permissions,
  permissionsRelations,
  type Role,
  type RolePermission,
  rolePermissions,
  rolePermissionsRelations,
  roles,
  rolesRelations,
  type Tenant,
  tenants,
  tenantsSchema,
} from "./schema.js";
export { AccountService } from "./services/AccountService.js";
export {
  type AccountIdParam,
  accountIdParamSchema,
  type CreateAccountInput,
  createAccountSchema,
  type ListAccountsQuery,
  listAccountsQuerySchema,
  type UpdateAccountInput,
  updateAccountSchema,
} from "./validation/schemas.js";
