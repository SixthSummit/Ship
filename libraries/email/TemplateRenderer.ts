import type { EmailTemplate, RenderedTemplate } from "./types/index.js";

/**
 * TemplateRenderer - Renders email templates with variable substitution
 *
 * Supports:
 * - Variable substitution using {{variableName}} syntax
 * - Nested object access using dot notation: {{user.firstName}}
 * - Array indexing: {{items.0.name}}
 * - Conditional rendering: {{#if condition}}...{{/if}}
 * - Loops: {{#each items}}...{{/each}}
 * - Helper functions: {{formatDate date}}
 *
 * @example
 * ```typescript
 * const renderer = new TemplateRenderer();
 * const result = renderer.render(template, {
 *   firstName: 'John',
 *   lastName: 'Doe',
 *   importCount: 100
 * });
 * ```
 */
export default class TemplateRenderer {
  /**
   * Render a template with the provided variables
   * @param template - Template to render
   * @param variables - Variables to substitute in the template
   * @returns Rendered template
   */
  render<T extends Record<string, any> = Record<string, any>>(
    template: EmailTemplate<T>,
    variables: T,
  ): RenderedTemplate {
    // Render subject
    const subject = this.renderString(template.subject, variables as Record<string, any>);

    // Render HTML body (if present)
    const html = template.html
      ? this.renderString(template.html, variables as Record<string, any>)
      : undefined;

    // Render text body (if present)
    const text = template.text
      ? this.renderString(template.text, variables as Record<string, any>)
      : undefined;

    // Process tags
    const tags = template.tags?.map((tag) => ({
      name: tag,
      value: this.renderString(tag, variables as Record<string, any>),
    }));

    return {
      templateId: template.id,
      subject,
      html,
      text,
      from: template.from,
      replyTo: template.replyTo,
      tags,
    };
  }

  /**
   * Render a string with variable substitution
   * @param content - String content with {{variable}} placeholders
   * @param variables - Variables to substitute
   * @returns Rendered string
   */
  private renderString(content: string, variables: Record<string, any>): string {
    let result = content;

    // Handle loops FIRST {{#each items}}...{{/each}}
    // Loops need to be processed before conditionals because they create context variables like @first, @last
    result = this.renderLoops(result, variables);

    // Handle conditional blocks {{#if condition}}...{{/if}}
    result = this.renderConditionals(result, variables);

    // Handle helper functions {{helperName arg1 arg2}} - BEFORE simple variables
    result = this.renderHelpers(result, variables);

    // Handle simple variable substitution {{variableName}}
    result = this.renderVariables(result, variables);

    return result;
  }

  /**
   * Render simple variable substitutions
   * Supports:
   * - {{variableName}}
   * - {{user.firstName}} (nested objects)
   * - {{items.0.name}} (array indexing)
   */
  private renderVariables(content: string, variables: Record<string, any>): string {
    return content.replace(/\{\{([^#/}]+)\}\}/g, (match, variablePath) => {
      const trimmedPath = variablePath.trim();
      const value = this.getNestedValue(variables, trimmedPath);

      if (value === undefined || value === null) {
        return "";
      }

      return String(value);
    });
  }

  /**
   * Render conditional blocks
   * Syntax: {{#if variableName}}content{{/if}}
   */
  private renderConditionals(content: string, variables: Record<string, any>): string {
    const conditionalRegex = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

    return content.replace(conditionalRegex, (match, condition, innerContent) => {
      const trimmedCondition = condition.trim();

      // Direct property access for variables starting with @
      const value = trimmedCondition.startsWith("@")
        ? variables[trimmedCondition]
        : this.getNestedValue(variables, trimmedCondition);

      // Evaluate truthiness
      const isTruthy = this.isTruthy(value);

      return isTruthy ? innerContent : "";
    });
  }

  /**
   * Render loop blocks
   * Syntax: {{#each items}}{{this.name}}{{/each}}
   */
  private renderLoops(content: string, variables: Record<string, any>): string {
    const loopRegex = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/g;

    return content.replace(loopRegex, (match, arrayPath, innerContent) => {
      const trimmedPath = arrayPath.trim();
      const array = this.getNestedValue(variables, trimmedPath);

      if (!Array.isArray(array)) {
        return "";
      }

      return array
        .map((item, index) => {
          // Create context with 'this' pointing to current item
          const itemContext = {
            ...variables,
            this: item,
            "@index": index,
            "@first": index === 0,
            "@last": index === array.length - 1,
          };

          // Render inner content with full processing (conditionals, helpers, and variables)
          let renderedContent = innerContent;
          renderedContent = this.renderConditionals(renderedContent, itemContext);
          renderedContent = this.renderHelpers(renderedContent, itemContext);
          renderedContent = this.renderVariables(renderedContent, itemContext);
          return renderedContent;
        })
        .join("");
    });
  }

  /**
   * Render helper functions
   * Supports:
   * - {{formatNumber value}} - Format number with commas
   * - {{formatDate date}} - Format date
   * - {{pluralize count singular plural}} - Pluralize based on count
   */
  private renderHelpers(content: string, variables: Record<string, any>): string {
    // Match helper functions that don't use # or /
    const helperRegex = /\{\{(?!#|\/)(formatNumber|formatDate|pluralize)\s+([^}]+)\}\}/g;

    return content.replace(helperRegex, (match, helperName, args) => {
      const argsList = args.split(/\s+/).map((arg: string) => {
        // Check if it's a variable reference or a literal
        if (arg.startsWith("'") || arg.startsWith('"')) {
          return arg.slice(1, -1); // Remove quotes
        }
        return this.getNestedValue(variables, arg);
      });

      switch (helperName) {
        case "formatNumber":
          return this.formatNumber(argsList[0]);
        case "formatDate":
          return this.formatDate(argsList[0]);
        case "pluralize":
          return this.pluralize(argsList[0], argsList[1], argsList[2]);
        default:
          return match; // Return original if helper not found
      }
    });
  }

  /**
   * Get nested value from object using dot notation
   * @param obj - Object to traverse
   * @param path - Dot-notation path (e.g., "user.firstName" or "items.0.name")
   * @returns Value at path or undefined
   */
  private getNestedValue(obj: any, path: string): any {
    const parts = path.split(".");
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined;
      }

      // Handle array indexing
      const arrayIndex = parseInt(part, 10);
      if (!Number.isNaN(arrayIndex)) {
        current = current[arrayIndex];
      } else {
        current = current[part];
      }
    }

    return current;
  }

  /**
   * Check if a value is truthy
   */
  private isTruthy(value: any): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  /**
   * Format a number with comma separators
   */
  private formatNumber(value: any): string {
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    return num.toLocaleString();
  }

  /**
   * Format a date
   */
  private formatDate(value: any): string {
    if (!value) return "";

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  /**
   * Pluralize based on count
   */
  private pluralize(count: any, singular: string, plural: string): string {
    const num = Number(count);
    return num === 1 ? singular : plural;
  }
}
