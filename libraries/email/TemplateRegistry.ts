import type { EmailTemplate } from "./types/index.js";

/**
 * TemplateRegistry - Registry for managing email templates
 *
 * Provides centralized storage and retrieval of email templates.
 * Templates can be registered at application startup and retrieved by ID.
 *
 * @example
 * ```typescript
 * const registry = new TemplateRegistry();
 *
 * // Register a template
 * registry.register({
 *   id: 'welcome',
 *   name: 'Welcome Email',
 *   subject: 'Welcome to {{appName}}!',
 *   html: '<h1>Hello {{firstName}}!</h1>',
 *   text: 'Hello {{firstName}}!'
 * });
 *
 * // Get a template
 * const template = registry.get('welcome');
 *
 * // List all templates
 * const templates = registry.list();
 * ```
 */
export default class TemplateRegistry {
  private templates: Map<string, EmailTemplate<any>>;

  constructor() {
    this.templates = new Map();
  }

  /**
   * Register a new email template
   * @param template - Template to register
   * @throws Error if template with same ID already exists
   */
  register<T = Record<string, any>>(template: EmailTemplate<T>): void {
    if (this.templates.has(template.id)) {
      throw new Error(`Template with ID '${template.id}' already exists`);
    }

    // Validate template has at least subject and one body type
    if (!template.subject) {
      throw new Error(`Template '${template.id}' must have a subject`);
    }

    if (!template.html && !template.text) {
      throw new Error(`Template '${template.id}' must have either html or text content`);
    }

    this.templates.set(template.id, template as EmailTemplate<any>);
  }

  /**
   * Register multiple templates at once
   * @param templates - Array of templates to register
   */
  registerMany(templates: EmailTemplate<any>[]): void {
    for (const template of templates) {
      this.register(template);
    }
  }

  /**
   * Get a template by ID
   * @param id - Template ID
   * @returns Template or undefined if not found
   */
  get(id: string): EmailTemplate<any> | undefined {
    return this.templates.get(id);
  }

  /**
   * Get a template by ID or throw error if not found
   * @param id - Template ID
   * @returns Template
   * @throws Error if template not found
   */
  getOrThrow(id: string): EmailTemplate<any> {
    const template = this.templates.get(id);
    if (!template) {
      throw new Error(`Template with ID '${id}' not found`);
    }
    return template;
  }

  /**
   * Check if a template exists
   * @param id - Template ID
   * @returns True if template exists
   */
  has(id: string): boolean {
    return this.templates.has(id);
  }

  /**
   * Remove a template from the registry
   * @param id - Template ID
   * @returns True if template was removed
   */
  unregister(id: string): boolean {
    return this.templates.delete(id);
  }

  /**
   * Clear all templates from the registry
   */
  clear(): void {
    this.templates.clear();
  }

  /**
   * List all registered templates
   * @returns Array of all templates
   */
  list(): EmailTemplate<any>[] {
    return Array.from(this.templates.values());
  }

  /**
   * Get all template IDs
   * @returns Array of template IDs
   */
  listIds(): string[] {
    return Array.from(this.templates.keys());
  }

  /**
   * Get count of registered templates
   * @returns Number of templates
   */
  count(): number {
    return this.templates.size;
  }

  /**
   * Find templates by tag
   * @param tag - Tag to search for
   * @returns Array of templates with the specified tag
   */
  findByTag(tag: string): EmailTemplate[] {
    return Array.from(this.templates.values()).filter((template) => template.tags?.includes(tag));
  }
}
