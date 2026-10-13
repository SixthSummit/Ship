# `libraries/email/` — Resend-backed transactional email

A type-safe email service built around [Resend](https://resend.com/), with a built-in template system (variable substitution, conditionals, loops), batch sending, scheduling, and tagging.

> **Install via**: `ship-api add -l email`. Pulls in the `resend` SDK; configure `RESEND_API_KEY` + `RESEND_DEFAULT_FROM` in your `.env`.

## What's exported

- `EmailService` — the main service class
- `TemplateRegistry` — manages registered templates
- `TemplateRenderer` — renders a template with variables
- The full type set for `SendEmailOptions`, `EmailTemplate<TVars>`, batch payloads, etc.

```ts
import {
  EmailService,
  TemplateRegistry,
  TemplateRenderer,
  type EmailTemplate,
  type SendEmailOptions,
} from "@sixthsummit/ship-api/libraries/email";
```

## Installation

## Configuration

### Environment Variables

Add the following environment variables to your `.env` file:

```bash
# Required: Resend API key
RESEND_API_KEY=re_your_api_key_here

# Optional: Default "from" email address
RESEND_DEFAULT_FROM=noreply@yourdomain.com
```

### Domain Setup

Before sending emails, you need to:

1. Add and verify your domain in the [Resend dashboard](https://resend.com/domains)
2. Configure DNS records (SPF, DKIM, DMARC)
3. Use an email address from your verified domain as the sender

## Quick Start

Construct the service once in your app's composition root (`src/index.ts`) and inject it into the modules and jobs that send mail:

```typescript
// src/index.ts
import { EmailService } from "@sixthsummit/ship-api/libraries/email";
import { welcomeTemplate, passwordResetTemplate } from "./templates/index.js";
import { env } from "./environment.js";

const emailService = new EmailService(env.RESEND_API_KEY, env.RESEND_DEFAULT_FROM);
emailService.registerTemplates([welcomeTemplate, passwordResetTemplate]);

// Pass `emailService` into modules / jobs / route deps that need it.
```

### Sending via a registered template

```typescript
await emailService.sendEmailWithTemplate({
  templateId: "welcome",
  to: "user@example.com",
  variables: {
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
  },
});
```

### Direct send (no template)

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  subject: "Welcome!",
  text: "Welcome to our platform",
});
```

### HTML Email

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  subject: "Welcome!",
  html: `
    <h1>Welcome to our platform!</h1>
    <p>We're excited to have you on board.</p>
  `,
});
```

### Multiple Recipients

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: ["user1@example.com", "user2@example.com"],
  subject: "Team Update",
  html: "<p>Important team announcement</p>",
});
```

### Named Recipients

```typescript
await emailService.sendEmail({
  from: { name: "ShipAPI App", email: "noreply@yourdomain.com" },
  to: [
    { name: "John Doe", email: "john@example.com" },
    { name: "Jane Smith", email: "jane@example.com" },
  ],
  subject: "Welcome Team!",
  html: "<p>Welcome to the team!</p>",
});
```

### CC and BCC

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  cc: "manager@example.com",
  bcc: ["audit@example.com", "compliance@example.com"],
  subject: "Project Update",
  html: "<p>Project status update</p>",
});
```

### Reply-To

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  replyTo: "support@yourdomain.com",
  subject: "Need Help?",
  html: "<p>Click reply if you need assistance</p>",
});
```

### Attachments

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  subject: "Invoice Attached",
  html: "<p>Please find your invoice attached.</p>",
  attachments: [
    {
      filename: "invoice.pdf",
      content: pdfBuffer, // Buffer
      contentType: "application/pdf",
    },
    {
      filename: "logo.png",
      content: "base64EncodedString", // Base64 string
      contentType: "image/png",
    },
  ],
});
```

### Tags for Tracking

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  subject: "Welcome!",
  html: "<p>Welcome email</p>",
  tags: [
    { name: "category", value: "onboarding" },
    { name: "user_id", value: "12345" },
  ],
});
```

### Custom Headers

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  subject: "Custom Headers",
  html: "<p>Email with custom headers</p>",
  headers: {
    "X-Custom-Header": "custom-value",
    "X-Priority": "1",
  },
});
```

### Scheduled Emails

```typescript
await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  subject: "Scheduled Email",
  html: "<p>This email was scheduled</p>",
  scheduledAt: "2025-12-31T23:59:59Z", // ISO 8601 format
});
```

### Batch Emails

Send up to 100 emails in a single batch for better performance:

```typescript
const results = await emailService.sendBatchEmails({
  emails: [
    {
      from: "noreply@yourdomain.com",
      to: "user1@example.com",
      subject: "Welcome User 1",
      html: "<p>Personalized welcome message</p>",
    },
    {
      from: "noreply@yourdomain.com",
      to: "user2@example.com",
      subject: "Welcome User 2",
      html: "<p>Personalized welcome message</p>",
    },
    // ... up to 100 emails
  ],
});

// Check results
results.data?.forEach((result, index) => {
  console.log(`Email ${index} sent with ID: ${result.id}`);
});
```

### Using Default From Address

```typescript
// Set default from address in constructor
const emailService = new EmailService(undefined, "noreply@yourdomain.com");

// Now you can omit "from" in sendEmail
await emailService.sendEmail({
  to: "user@example.com",
  subject: "Welcome!",
  text: "Welcome to our platform",
});

// Or set it later
emailService.setDefaultFrom("support@yourdomain.com");
```

## Email Templates

The email service includes a powerful template system that allows you to create reusable email templates with variable substitution, conditionals, and loops.

### Using Templates

Register templates once at app startup (in `src/index.ts`), then use the configured `emailService` instance:

```typescript
await emailService.sendEmailWithTemplate({
  templateId: "welcome",
  to: "user@example.com",
  variables: {
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
    activationUrl: "https://yourdomain.com/activate/token123",
  },
});

// Send import completion email
await emailService.sendEmailWithTemplate({
  templateId: "import-completion",
  to: "user@example.com",
  variables: {
    firstName: "John",
    importSource: "Twitter Followers",
    processedCount: 100,
    matchedAccountCount: 50,
    createdAccountCount: 30,
    matchedPersonCount: 40,
    createdPersonCount: 20,
    edgeCreatedCount: 80,
    rejectedCount: 5,
    viewImportUrl: "https://yourdomain.com/imports/123",
  },
});
```

### Available Templates

The library ships with no pre-built templates — define your own per-module.

### Creating Custom Templates

Templates live alongside the module that owns them, e.g. `modules/orders/templates/`:

**Step 1: Create the template file** (`modules/orders/templates/OrderConfirmationTemplate.ts`):

```typescript
import type { EmailTemplate } from "@sixthsummit/ship-api/libraries/email";
import type { OrderConfirmationVariables } from "./types.js";

export const orderConfirmationTemplate: EmailTemplate<OrderConfirmationVariables> = {
  id: "order-confirmation",
  name: "Order Confirmation",
  description: "Sent when a customer places an order",
  subject: "Order Confirmation #{{orderNumber}}",
  html: `
    <h1>Thank you for your order, {{customerName}}!</h1>
    <p>Order Number: {{orderNumber}}</p>
    <p>Total: ${{total}}</p>

    {{#if hasDiscount}}
      <p>Discount Applied: {{discount}}%</p>
    {{/if}}

    <h2>Items:</h2>
    <ul>
      {{#each items}}
        <li>{{this.name}} - ${{this.price}} x {{this.quantity}}</li>
      {{/each}}
    </ul>
  `,
  text: `...`,
  tags: ["order", "confirmation"],
};
```

**Step 2: Define type-safe variables** (`modules/orders/templates/types.ts`):

```typescript
export interface OrderConfirmationVariables {
  customerName: string;
  orderNumber: string;
  total: number;
  hasDiscount?: boolean;
  discount?: number;
  items: Array<{
    name: string;
    price: number;
    quantity: number;
  }>;
}
```

**Step 3: Export from module** (`modules/orders/templates/index.ts`):

```typescript
import type { EmailTemplate } from "@sixthsummit/ship-api/libraries/email";
import { orderConfirmationTemplate } from "./OrderConfirmationTemplate.js";

export { orderConfirmationTemplate } from "./OrderConfirmationTemplate.js";
export * from "./types.js";

export const orderTemplates: EmailTemplate[] = [orderConfirmationTemplate];
```

**Step 4: Register at app startup** (`src/index.ts`):

```typescript
import { EmailService } from "@sixthsummit/ship-api/libraries/email";
import { orderTemplates } from "./modules/orders/templates/index.js";
import { userTemplates } from "./modules/users/templates/index.js";
import { env } from "./environment.js";

const emailService = new EmailService(env.RESEND_API_KEY, env.RESEND_DEFAULT_FROM);
emailService.registerTemplates([...userTemplates, ...orderTemplates]);
```

**Step 5: Use the template**:

```typescript
await emailService.sendEmailWithTemplate({
  templateId: "order-confirmation",
  to: "customer@example.com",
  variables: {
    customerName: "Jane Smith",
    orderNumber: "ORD-12345",
    total: 99.99,
    hasDiscount: true,
    discount: 10,
    items: [
      { name: "Product A", price: 49.99, quantity: 1 },
      { name: "Product B", price: 49.99, quantity: 1 },
    ],
  },
});
```

### Template Syntax

#### Variable Substitution

```typescript
// Simple variables
"Hello {{firstName}}!";

// Nested objects
"Email: {{user.email}}";

// Array indexing
"First item: {{items.0.name}}";
```

#### Conditionals

```typescript
// Show content if variable is truthy
`{{#if showWelcome}}
  <p>Welcome!</p>
{{/if}}`
// Nested conditionals
`{{#if user.isActive}}
  <p>Active user</p>
{{/if}}`;
```

#### Loops

```typescript
// Iterate over array
`{{#each items}}
  <li>{{this.name}}</li>
{{/each}}`
// Access loop variables
`{{#each items}}
  <li>{{@index}}: {{this.name}}</li>
  {{#if @first}}(First){{/if}}
  {{#if @last}}(Last){{/if}}
{{/each}}`;
```

#### Helper Functions

```typescript
// Format numbers with commas
"Total: {{formatNumber count}}";
// Output: "Total: 1,000,000"

// Format dates
"Date: {{formatDate date}}";
// Output: "Date: January 15, 2025"

// Pluralize based on count
"{{count}} {{pluralize count 'item' 'items'}}";
// Output: "1 item" or "5 items"
```

### Batch Sending with Templates

```typescript
// Send multiple emails using templates
const results = await emailService.sendBatchEmailsWithTemplates([
  {
    templateId: "welcome",
    to: "user1@example.com",
    variables: { firstName: "John", lastName: "Doe", email: "user1@example.com" },
  },
  {
    templateId: "welcome",
    to: "user2@example.com",
    variables: { firstName: "Jane", lastName: "Smith", email: "user2@example.com" },
  },
]);
```

### Template Management

```typescript
// Register a single template
emailService.registerTemplate(template);

// Register multiple templates
emailService.registerTemplates([template1, template2, template3]);

// Check if template exists
if (emailService.hasTemplate("welcome")) {
  // Template is available
}

// Get a template
const template = emailService.getTemplate("welcome");

// List all templates
const allTemplates = emailService.listTemplates();

// Render template without sending (for preview)
const rendered = emailService.renderTemplate({
  templateId: "welcome",
  variables: { firstName: "John", lastName: "Doe", email: "john@example.com" },
});
console.log(rendered.subject); // "Welcome to ShipAPI App, John!"
console.log(rendered.html); // Rendered HTML
console.log(rendered.text); // Rendered text
```

### Template Organization Best Practices

1. **Module Ownership** - Each module owns its email templates
   - User/auth templates: `modules/users/templates/`
   - Import templates: `modules/imports/templates/`
   - Order templates: `modules/orders/templates/`

2. **Type Safety** - Define interfaces for template variables in `types.ts`

3. **Centralized Registration** - Construct `EmailService` once in `src/index.ts` and register every module's templates against the same instance.

4. **Consistent Structure** - Each module's templates directory should have:
   - Individual template files (`WelcomeTemplate.ts`)
   - Type definitions (`types.ts`)
   - Barrel export (`index.ts`)

### Why This Structure?

- **Cohesion**: Templates live with the domain logic they support
- **Modularity**: Removing a module removes its templates
- **Discoverability**: Easy to find templates related to a feature
- **Separation of Concerns**: Email library stays generic and reusable
- **Type Safety**: TypeScript ensures correct variable usage

### Error Handling

```typescript
const result = await emailService.sendEmail({
  from: "noreply@yourdomain.com",
  to: "user@example.com",
  subject: "Welcome!",
  text: "Welcome!",
});

if (result.error) {
  console.error("Failed to send email:", result.error.message);
  // Handle error (retry, log, notify, etc.)
} else {
  console.log("Email sent successfully:", result.id);
  // Store email ID for tracking
}
```

### Batch Error Handling

```typescript
const results = await emailService.sendBatchEmails({
  emails: [...],
});

if (results.error) {
  console.error("Batch send failed:", results.error.message);
} else {
  results.data?.forEach((result, index) => {
    console.log(`Email ${index} sent with ID: ${result.id}`);
  });
}
```

## Common Use Cases

### Welcome Email

```typescript
async function sendWelcomeEmail(user: { email: string; name: string }) {
  const emailService = new EmailService();

  return await emailService.sendEmail({
    from: "noreply@yourdomain.com",
    to: { name: user.name, email: user.email },
    subject: "Welcome to ShipAPI App!",
    html: `
      <h1>Welcome, ${user.name}!</h1>
      <p>We're excited to have you on board.</p>
      <p>Get started by logging in to your account.</p>
    `,
    tags: [
      { name: "type", value: "welcome" },
      { name: "user_id", value: user.id },
    ],
  });
}
```

### Password Reset

```typescript
async function sendPasswordResetEmail(user: { email: string }, resetToken: string) {
  const emailService = new EmailService();
  const resetUrl = `https://yourdomain.com/reset-password?token=${resetToken}`;

  return await emailService.sendEmail({
    from: "noreply@yourdomain.com",
    to: user.email,
    replyTo: "support@yourdomain.com",
    subject: "Password Reset Request",
    html: `
      <h1>Password Reset</h1>
      <p>Click the link below to reset your password:</p>
      <a href="${resetUrl}">Reset Password</a>
      <p>This link will expire in 1 hour.</p>
      <p>If you didn't request this, please ignore this email.</p>
    `,
    tags: [{ name: "type", value: "password_reset" }],
  });
}
```

### Bulk User Notifications

```typescript
async function sendBulkNotifications(
  users: Array<{ email: string; name: string }>,
  message: string,
) {
  const emailService = new EmailService();

  // Split into batches of 100
  const batches = [];
  for (let i = 0; i < users.length; i += 100) {
    batches.push(users.slice(i, i + 100));
  }

  // Send each batch
  for (const batch of batches) {
    await emailService.sendBatchEmails({
      emails: batch.map((user) => ({
        from: "notifications@yourdomain.com",
        to: { name: user.name, email: user.email },
        subject: "Important Update",
        html: `<p>Hi ${user.name},</p><p>${message}</p>`,
        tags: [{ name: "type", value: "bulk_notification" }],
      })),
    });
  }
}
```

## API Reference

### `EmailService`

#### Constructor

```typescript
new EmailService(
  apiKey?: string,
  defaultFrom?: string
)
```

- `apiKey` - Optional Resend API key (defaults to `RESEND_API_KEY` environment variable)
- `defaultFrom` - Optional default "from" email address

**Note**: Templates are not auto-registered. Construct `EmailService` once at app startup (in `src/index.ts`) and call `registerTemplates([...])` with each module's template list.

#### Methods

##### `sendEmail(options: SendEmailOptions): Promise<SendEmailResult>`

Send a single email.

##### `sendBatchEmails(options: SendBatchEmailsOptions): Promise<SendBatchEmailsResult>`

Send multiple emails in a batch (max 100).

##### `sendEmailWithTemplate<T>(options: RenderTemplateOptions<T> & EmailOptions): Promise<SendEmailResult>`

Send an email using a template.

##### `sendBatchEmailsWithTemplates<T>(emails: Array<...>): Promise<SendBatchEmailsResult>`

Send multiple emails using templates.

##### `registerTemplate<T>(template: EmailTemplate<T>): void`

Register an email template.

##### `registerTemplates(templates: EmailTemplate[]): void`

Register multiple email templates.

##### `getTemplate(id: string): EmailTemplate | undefined`

Get a registered template by ID.

##### `listTemplates(): EmailTemplate[]`

List all registered templates.

##### `hasTemplate(id: string): boolean`

Check if a template exists.

##### `renderTemplate<T>(options: RenderTemplateOptions<T>): RenderedTemplate`

Render a template with variables (without sending).

##### `getDefaultFrom(): string`

Get the default from address.

##### `setDefaultFrom(defaultFrom: string): void`

Set the default from address.

### Types

See [types/index.ts](./types/index.ts) for detailed type definitions.

## Best Practices

### Email Sending

1. **Use Verified Domains** - Always send from verified domains to ensure deliverability
2. **Handle Errors** - Always check for errors in the response and handle them appropriately
3. **Use Tags** - Add tags to track email types and measure performance
4. **Batch When Possible** - Use batch sending for better performance when sending multiple emails
5. **Set Reply-To** - Always provide a reply-to address for customer support
6. **Test Thoroughly** - Test emails in development before sending to production
7. **Monitor Delivery** - Use Resend's dashboard to monitor email delivery and engagement

### Template Usage

8. **Use Templates** - Leverage templates for consistent branding and easier maintenance
9. **Single Instance** - Construct `EmailService` once at app startup and inject it into the modules / jobs that need it; don't reconstruct per request
10. **Type-Safe Variables** - Define interfaces for template variables to catch errors at compile time
11. **Preview Templates** - Use `renderTemplate()` to preview emails before sending
12. **Organize Templates** - Keep templates in their respective module directories
13. **Version Control** - Keep templates in version control for tracking changes
14. **Module Ownership** - Each module should own and maintain its email templates

## Testing

When testing in development:

1. Use Resend's test mode or a test domain
2. Send to your own email addresses
3. Check Resend dashboard for delivery status
4. Verify email content in your inbox

## Troubleshooting

### "From address is required"

Make sure you either:

- Provide a `from` address in `sendEmail()` options
- Set a default from address in the constructor
- Set `RESEND_DEFAULT_FROM` environment variable

### "Resend API key is required"

Make sure you have set the `RESEND_API_KEY` environment variable.

### Email not delivered

1. Check Resend dashboard for delivery status
2. Verify your domain is properly configured
3. Check spam folders
4. Ensure recipient email addresses are valid

## Resources

- [Resend Documentation](https://resend.com/docs)
- [Resend API Reference](https://resend.com/docs/api-reference)
- [Resend Node.js SDK](https://github.com/resendlabs/resend-node)
