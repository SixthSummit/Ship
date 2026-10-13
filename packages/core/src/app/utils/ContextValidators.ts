/**
 * Context validators for common data access patterns
 */
export class ContextValidators {
  /**
   * Validates that the user can only access their own data
   */
  static ownData(req: any, entity: any): boolean {
    if (!req.user || !entity) return false;
    return req.user.id === entity.accountId || req.user.id === entity.userId;
  }

  /**
   * Validates that the user can access data they created
   */
  static ownCreatedData(req: any, entity: any): boolean {
    if (!req.user || !entity) return false;
    return req.user.id === entity.createdById || req.user.id === entity.authorId;
  }

  /**
   * Validates that the user can access data in their organization/group
   */
  static sameOrganization(req: any, entity: any): boolean {
    if (!req.user || !entity) return false;
    return req.user.organizationId === entity.organizationId || req.user.groupId === entity.groupId;
  }

  /**
   * Validates that the user can access data they have a relationship with
   */
  static hasRelationship(req: any, entity: any, relationshipField: string): boolean {
    if (!req.user || !entity) return false;
    return req.user.id === entity[relationshipField];
  }

  /**
   * Validates that the user can access data based on a custom field comparison
   */
  static customField(req: any, entity: any, fieldPath: string): boolean {
    if (!req.user || !entity) return false;

    const fieldValue = ContextValidators.getNestedValue(entity, fieldPath);
    return req.user.id === fieldValue;
  }

  /**
   * Validates that the user can access data based on multiple conditions (AND logic)
   */
  static and(
    ...validators: Array<(req: any, entity: any) => boolean>
  ): (req: any, entity: any) => boolean {
    return (req: any, entity: any) => {
      return validators.every((validator) => validator(req, entity));
    };
  }

  /**
   * Validates that the user can access data based on multiple conditions (OR logic)
   */
  static or(
    ...validators: Array<(req: any, entity: any) => boolean>
  ): (req: any, entity: any) => boolean {
    return (req: any, entity: any) => {
      return validators.some((validator) => validator(req, entity));
    };
  }

  /**
   * Validates that the user has admin privileges (bypasses context checks)
   */
  static adminBypass(req: any, entity: any): boolean {
    return req.user?.hasPermission("admin") || req.user?.hasPermission("superuser");
  }

  /**
   * Validates that the user can access data based on a custom function
   */
  static custom(validator: (req: any, entity: any) => boolean): (req: any, entity: any) => boolean {
    return validator;
  }

  /**
   * Helper to get nested object values using dot notation
   */
  private static getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((current, key) => current?.[key], obj);
  }
}
