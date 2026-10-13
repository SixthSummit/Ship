import { Resend } from "resend";
import TemplateRegistry from "./TemplateRegistry.js";
import TemplateRenderer from "./TemplateRenderer.js";
import type {
  EmailAddress,
  EmailTemplate,
  RenderedTemplate,
  RenderTemplateOptions,
  SendBatchEmailsOptions,
  SendBatchEmailsResult,
  SendEmailOptions,
  SendEmailResult,
} from "./types/index.js";

/**
 * EmailService - Service for sending emails using Resend
 *
 * @example
 * ```typescript
 * const emailService = new EmailService(env.RESEND_API_KEY, env.RESEND_DEFAULT_FROM);
 *
 * // Send a simple email
 * await emailService.sendEmail({
 *   from: 'noreply@example.com',
 *   to: 'user@example.com',
 *   subject: 'Welcome!',
 *   text: 'Welcome to our platform',
 * });
 *
 * // Send an HTML email
 * await emailService.sendEmail({
 *   from: 'noreply@example.com',
 *   to: ['user1@example.com', 'user2@example.com'],
 *   subject: 'Welcome!',
 *   html: '<h1>Welcome to our platform</h1>',
 * });
 *
 * // Send batch emails
 * await emailService.sendBatchEmails({
 *   emails: [
 *     {
 *       from: 'noreply@example.com',
 *       to: 'user1@example.com',
 *       subject: 'Welcome User 1',
 *       text: 'Welcome!',
 *     },
 *     {
 *       from: 'noreply@example.com',
 *       to: 'user2@example.com',
 *       subject: 'Welcome User 2',
 *       text: 'Welcome!',
 *     },
 *   ],
 * });
 *
 * // Send email using a template
 * await emailService.sendEmailWithTemplate({
 *   templateId: 'welcome',
 *   to: 'user@example.com',
 *   variables: {
 *     firstName: 'John',
 *     lastName: 'Doe',
 *     email: 'user@example.com',
 *   },
 * });
 *
 * // Register a custom template
 * emailService.registerTemplate({
 *   id: 'custom-welcome',
 *   name: 'Custom Welcome',
 *   subject: 'Welcome {{firstName}}!',
 *   html: '<h1>Hello {{firstName}} {{lastName}}!</h1>',
 * });
 * ```
 */
export default class EmailService {
  private resend: Resend;
  private defaultFrom: string;
  private templateRegistry: TemplateRegistry;
  private templateRenderer: TemplateRenderer;

  /**
   * Initialize Email Service
   * @param apiKey - Resend API key. Required at runtime — pass it from your app's validated env (no implicit env fallback).
   * @param defaultFrom - Default "from" email address. Required at runtime.
   */
  constructor(apiKey?: string, defaultFrom?: string) {
    const key = apiKey;

    if (!key || key.trim() === "") {
      throw new Error(
        "Resend API key is required — pass it to the EmailService constructor (e.g. from your app's validated env).",
      );
    }

    const from = defaultFrom;

    if (!from || from.trim() === "") {
      throw new Error(
        "Default from address is required — pass it to the EmailService constructor (e.g. from your app's validated env).",
      );
    }

    this.resend = new Resend(key);
    this.defaultFrom = from;
    this.templateRegistry = new TemplateRegistry();
    this.templateRenderer = new TemplateRenderer();
  }

  /**
   * Send a single email
   * @param options - Email options
   * @returns Object containing email ID and any errors
   *
   * @example
   * ```typescript
   * const result = await emailService.sendEmail({
   *   from: 'noreply@example.com',
   *   to: 'user@example.com',
   *   subject: 'Welcome!',
   *   text: 'Welcome to our platform',
   * });
   *
   * if (result.error) {
   *   console.error('Failed to send email:', result.error);
   * } else {
   *   console.log('Email sent:', result.id);
   * }
   * ```
   */
  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    try {
      // Use default from if not provided and normalize if it's an object
      let from: string;
      const fromOption = options.from;

      if (fromOption) {
        // Normalize from address if it's an object
        if (typeof fromOption === "string") {
          from = fromOption;
        } else {
          const fromObject = fromOption as { name: string; email: string };
          from = `${fromObject.name} <${fromObject.email}>`;
        }
      } else {
        from = this.defaultFrom;
      }

      if (!from) {
        return {
          error: new Error("From address is required. Provide it in options or set a default."),
        };
      }

      // Validate that at least text or html is provided
      if (!options.text && !options.html) {
        return {
          error: new Error("Email must have either text or html content"),
        };
      }

      // Normalize email addresses
      const to = this.normalizeEmailAddresses(options.to);
      const cc = options.cc ? this.normalizeEmailAddresses(options.cc) : undefined;
      const bcc = options.bcc ? this.normalizeEmailAddresses(options.bcc) : undefined;
      const replyTo = options.replyTo ? this.normalizeEmailAddresses(options.replyTo) : undefined;

      // Prepare email payload
      const emailPayload: any = {
        from,
        to,
        subject: options.subject,
        cc,
        bcc,
        replyTo,
        attachments: options.attachments,
        tags: options.tags,
        headers: options.headers,
        scheduledAt: options.scheduledAt,
      };

      // Add text or html (at least one must be present)
      if (options.html) {
        emailPayload.html = options.html;
        if (options.text) {
          emailPayload.text = options.text;
        }
      } else if (options.text) {
        emailPayload.text = options.text;
      }

      // Send email using Resend
      const response = await this.resend.emails.send(emailPayload);

      // Handle Resend response
      if (response.error) {
        return {
          error: new Error(response.error.message),
        };
      }

      return {
        id: response.data?.id,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Send multiple emails in a batch (up to 100 emails per batch)
   * @param options - Batch email options
   * @returns Array of results for each email
   *
   * @example
   * ```typescript
   * const results = await emailService.sendBatchEmails({
   *   emails: [
   *     {
   *       from: 'noreply@example.com',
   *       to: 'user1@example.com',
   *       subject: 'Welcome User 1',
   *       text: 'Welcome!',
   *     },
   *     {
   *       from: 'noreply@example.com',
   *       to: 'user2@example.com',
   *       subject: 'Welcome User 2',
   *       text: 'Welcome!',
   *     },
   *   ],
   * });
   *
   * results.forEach((result, index) => {
   *   if (result.error) {
   *     console.error(`Email ${index} failed:`, result.error);
   *   } else {
   *     console.log(`Email ${index} sent:`, result.id);
   *   }
   * });
   * ```
   */
  async sendBatchEmails(options: SendBatchEmailsOptions): Promise<SendBatchEmailsResult> {
    try {
      // Validate batch size
      if (options.emails.length > 100) {
        throw new Error("Batch size cannot exceed 100 emails");
      }

      if (options.emails.length === 0) {
        return { data: [] };
      }

      // Prepare emails for batch send
      const emails = options.emails.map((email) => {
        const from = email.from || this.defaultFrom;

        if (!from) {
          throw new Error(
            "From address is required for all emails. Provide it in options or set a default.",
          );
        }

        // Validate that at least text or html is provided
        if (!email.text && !email.html) {
          throw new Error("Each email must have either text or html content");
        }

        const emailPayload: any = {
          from,
          to: this.normalizeEmailAddresses(email.to),
          subject: email.subject,
        };

        // Add text or html (at least one must be present)
        if (email.html) {
          emailPayload.html = email.html;
          if (email.text) {
            emailPayload.text = email.text;
          }
        } else if (email.text) {
          emailPayload.text = email.text;
        }

        // Add optional fields only if they exist
        if (email.cc) {
          emailPayload.cc = this.normalizeEmailAddresses(email.cc);
        }
        if (email.bcc) {
          emailPayload.bcc = this.normalizeEmailAddresses(email.bcc);
        }
        if (email.replyTo) {
          emailPayload.replyTo = this.normalizeEmailAddresses(email.replyTo);
        }
        if (email.attachments) {
          emailPayload.attachments = email.attachments;
        }
        if (email.tags) {
          emailPayload.tags = email.tags;
        }
        if (email.headers) {
          emailPayload.headers = email.headers;
        }
        if (email.scheduledAt) {
          emailPayload.scheduledAt = email.scheduledAt;
        }

        return emailPayload;
      });

      // Send batch using Resend
      const response = await this.resend.batch.send(emails);

      // Handle Resend response
      if (response.error) {
        return {
          error: new Error(response.error.message),
        };
      }

      return {
        data: response.data?.data || [],
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Normalize email addresses to string array
   * @param addresses - Email address(es) in various formats
   * @returns Array of email address strings
   */
  private normalizeEmailAddresses(addresses: EmailAddress | EmailAddress[]): string[] {
    const addressArray = Array.isArray(addresses) ? addresses : [addresses];

    return addressArray.map((addr) => {
      if (typeof addr === "string") {
        return addr;
      }
      // Format: "Name <email@example.com>"
      return `${addr.name} <${addr.email}>`;
    });
  }

  /**
   * Get the default from address
   * @returns Default from email address
   */
  getDefaultFrom(): string {
    return this.defaultFrom;
  }

  /**
   * Set the default from address
   * @param defaultFrom - New default from email address
   */
  setDefaultFrom(defaultFrom: string): void {
    this.defaultFrom = defaultFrom;
  }

  /**
   * Register an email template
   * @param template - Template to register
   */
  registerTemplate<T extends Record<string, any> = Record<string, any>>(
    template: EmailTemplate<T>,
  ): void {
    this.templateRegistry.register(template);
  }

  /**
   * Register multiple email templates
   * @param templates - Array of templates to register
   */
  registerTemplates(templates: EmailTemplate[]): void {
    this.templateRegistry.registerMany(templates);
  }

  /**
   * Get a registered template by ID
   * @param id - Template ID
   * @returns Template or undefined if not found
   */
  getTemplate(id: string): EmailTemplate | undefined {
    return this.templateRegistry.get(id);
  }

  /**
   * List all registered templates
   * @returns Array of all templates
   */
  listTemplates(): EmailTemplate[] {
    return this.templateRegistry.list();
  }

  /**
   * Check if a template exists
   * @param id - Template ID
   * @returns True if template exists
   */
  hasTemplate(id: string): boolean {
    return this.templateRegistry.has(id);
  }

  /**
   * Render a template with variables
   * @param options - Template rendering options
   * @returns Rendered template
   *
   * @example
   * ```typescript
   * const rendered = emailService.renderTemplate({
   *   templateId: 'welcome',
   *   variables: {
   *     firstName: 'John',
   *     lastName: 'Doe',
   *     email: 'john@example.com',
   *   },
   * });
   * ```
   */
  renderTemplate<T extends Record<string, any> = Record<string, any>>(
    options: RenderTemplateOptions<T>,
  ): RenderedTemplate {
    const template = this.templateRegistry.getOrThrow(options.templateId);
    const rendered = this.templateRenderer.render(template, options.variables);

    // Apply overrides from options
    if (options.from) {
      rendered.from = options.from;
    }
    if (options.replyTo) {
      rendered.replyTo = options.replyTo;
    }
    if (options.tags) {
      const additionalTags = options.tags.map((tag) => ({ name: tag, value: tag }));
      rendered.tags = [...(rendered.tags || []), ...additionalTags];
    }

    return rendered;
  }

  /**
   * Send an email using a template
   * @param options - Template rendering and email sending options
   * @returns Object containing email ID and any errors
   *
   * @example
   * ```typescript
   * const result = await emailService.sendEmailWithTemplate({
   *   templateId: 'welcome',
   *   to: 'user@example.com',
   *   variables: {
   *     firstName: 'John',
   *     lastName: 'Doe',
   *     email: 'user@example.com',
   *   },
   * });
   *
   * if (result.error) {
   *   console.error('Failed to send email:', result.error);
   * } else {
   *   console.log('Email sent:', result.id);
   * }
   * ```
   */
  async sendEmailWithTemplate<T extends Record<string, any> = Record<string, any>>(
    options: RenderTemplateOptions<T> & {
      to: EmailAddress | EmailAddress[];
      cc?: EmailAddress | EmailAddress[];
      bcc?: EmailAddress | EmailAddress[];
      attachments?: any[];
      headers?: Record<string, string>;
      scheduledAt?: string;
    },
  ): Promise<SendEmailResult> {
    try {
      // Render the template
      const rendered = this.renderTemplate({
        templateId: options.templateId,
        variables: options.variables,
        from: options.from,
        replyTo: options.replyTo,
        tags: options.tags,
      });

      // Send the email
      return await this.sendEmail({
        from: rendered.from || this.defaultFrom,
        to: options.to,
        cc: options.cc,
        bcc: options.bcc,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: rendered.replyTo,
        attachments: options.attachments,
        tags: rendered.tags,
        headers: options.headers,
        scheduledAt: options.scheduledAt,
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Send multiple emails using templates
   * @param emails - Array of template-based email options
   * @returns Array of results for each email
   *
   * @example
   * ```typescript
   * const results = await emailService.sendBatchEmailsWithTemplates([
   *   {
   *     templateId: 'welcome',
   *     to: 'user1@example.com',
   *     variables: { firstName: 'John', lastName: 'Doe', email: 'user1@example.com' },
   *   },
   *   {
   *     templateId: 'welcome',
   *     to: 'user2@example.com',
   *     variables: { firstName: 'Jane', lastName: 'Smith', email: 'user2@example.com' },
   *   },
   * ]);
   * ```
   */
  async sendBatchEmailsWithTemplates<T extends Record<string, any> = Record<string, any>>(
    emails: Array<
      RenderTemplateOptions<T> & {
        to: EmailAddress | EmailAddress[];
        cc?: EmailAddress | EmailAddress[];
        bcc?: EmailAddress | EmailAddress[];
        attachments?: any[];
        headers?: Record<string, string>;
        scheduledAt?: string;
      }
    >,
  ): Promise<SendBatchEmailsResult> {
    try {
      // Validate batch size
      if (emails.length > 100) {
        throw new Error("Batch size cannot exceed 100 emails");
      }

      if (emails.length === 0) {
        return { data: [] };
      }

      // Render all templates and prepare emails
      const preparedEmails = emails.map((emailOptions) => {
        const rendered = this.renderTemplate({
          templateId: emailOptions.templateId,
          variables: emailOptions.variables,
          from: emailOptions.from,
          replyTo: emailOptions.replyTo,
          tags: emailOptions.tags,
        });

        return {
          from: rendered.from || this.defaultFrom,
          to: emailOptions.to,
          cc: emailOptions.cc,
          bcc: emailOptions.bcc,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          replyTo: rendered.replyTo,
          attachments: emailOptions.attachments,
          tags: rendered.tags,
          headers: emailOptions.headers,
          scheduledAt: emailOptions.scheduledAt,
        };
      });

      // Send batch
      return await this.sendBatchEmails({ emails: preparedEmails });
    } catch (error) {
      return {
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
