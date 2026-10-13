/**
 * Email template definition
 */
export interface EmailTemplate<T = Record<string, any>> {
  /**
   * Unique identifier for the template
   */
  id: string;

  /**
   * Human-readable name for the template
   */
  name: string;

  /**
   * Description of the template purpose
   */
  description?: string;

  /**
   * Email subject line (supports variable substitution)
   */
  subject: string;

  /**
   * HTML email body (supports variable substitution)
   */
  html?: string;

  /**
   * Plain text email body (supports variable substitution)
   */
  text?: string;

  /**
   * Optional default "from" address for this template
   */
  from?: string;

  /**
   * Optional reply-to address for this template
   */
  replyTo?: string;

  /**
   * Template variables schema (for validation)
   */
  variables?: (keyof T)[];

  /**
   * Optional tags for the template
   */
  tags?: string[];
}

/**
 * Options for rendering a template
 */
export interface RenderTemplateOptions<T = Record<string, any>> {
  /**
   * Template ID to render
   */
  templateId: string;

  /**
   * Variables to substitute in the template
   */
  variables: T;

  /**
   * Optional: Override the default "from" address
   */
  from?: string;

  /**
   * Optional: Override the default "reply-to" address
   */
  replyTo?: string;

  /**
   * Optional: Additional tags to add
   */
  tags?: string[];
}

/**
 * Result of rendering a template
 */
export interface RenderedTemplate {
  /**
   * Template ID that was rendered
   */
  templateId: string;

  /**
   * Rendered subject line
   */
  subject: string;

  /**
   * Rendered HTML body (if template has HTML)
   */
  html?: string;

  /**
   * Rendered plain text body (if template has text)
   */
  text?: string;

  /**
   * From address
   */
  from?: string;

  /**
   * Reply-to address
   */
  replyTo?: string;

  /**
   * Tags for the email
   */
  tags?: Array<{ name: string; value: string }>;
}
