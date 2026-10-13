/**
 * EmailService Usage Examples
 *
 * This file demonstrates various use cases for the EmailService.
 * These are examples and should not be executed directly.
 *
 * For template-based emails, see the "Email Templates" section below.
 */

import { getEmailService } from "../../bootstrap/InitEmailTemplates.js";
import EmailService from "./EmailService.js";

// ============================================================================
// Basic Usage
// ============================================================================

async function basicExample() {
  const emailService = new EmailService();

  // Send a simple text email
  await emailService.sendEmail({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    text: "Welcome to our platform",
  });

  // Send an HTML email
  await emailService.sendEmail({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Welcome!",
    html: "<h1>Welcome to our platform!</h1>",
  });
}

// ============================================================================
// Advanced Features
// ============================================================================

async function advancedExample() {
  const emailService = new EmailService();

  // Named recipients with CC and BCC
  await emailService.sendEmail({
    from: "noreply@example.com",
    to: [
      { name: "John Doe", email: "john@example.com" },
      { name: "Jane Smith", email: "jane@example.com" },
    ],
    cc: "manager@example.com",
    bcc: ["audit@example.com", "compliance@example.com"],
    replyTo: "support@example.com",
    subject: "Team Update",
    html: "<p>Important team announcement</p>",
  });

  // Email with attachments and tags
  await emailService.sendEmail({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Invoice Attached",
    html: "<p>Please find your invoice attached.</p>",
    attachments: [
      {
        filename: "invoice.pdf",
        content: Buffer.from("PDF content here"),
        contentType: "application/pdf",
      },
    ],
    tags: [
      { name: "category", value: "invoices" },
      { name: "user_id", value: "12345" },
    ],
    headers: {
      "X-Priority": "1",
      "X-Invoice-Id": "INV-12345",
    },
  });

  // Scheduled email
  await emailService.sendEmail({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Scheduled Reminder",
    html: "<p>This is your scheduled reminder</p>",
    scheduledAt: "2025-12-31T23:59:59Z",
  });
}

// ============================================================================
// Batch Sending
// ============================================================================

async function batchExample() {
  const emailService = new EmailService();

  // Send personalized emails to multiple users
  const users = [
    { email: "user1@example.com", name: "User 1" },
    { email: "user2@example.com", name: "User 2" },
    { email: "user3@example.com", name: "User 3" },
  ];

  const results = await emailService.sendBatchEmails({
    emails: users.map((user) => ({
      from: "noreply@example.com",
      to: user.email,
      subject: `Welcome, ${user.name}!`,
      html: `<h1>Hi ${user.name}</h1><p>Welcome to our platform!</p>`,
      tags: [
        { name: "type", value: "welcome" },
        { name: "batch", value: "onboarding" },
      ],
    })),
  });

  // Check results
  if (results.error) {
    console.error("Batch failed:", results.error);
  } else {
    console.log(`Sent ${results.data?.length} emails`);
    results.data?.forEach((result, index) => {
      console.log(`Email ${index}: ${result.id}`);
    });
  }
}

// ============================================================================
// Error Handling
// ============================================================================

async function errorHandlingExample() {
  const emailService = new EmailService();

  const result = await emailService.sendEmail({
    from: "noreply@example.com",
    to: "user@example.com",
    subject: "Test Email",
    text: "Test content",
  });

  if (result.error) {
    console.error("Failed to send email:", result.error.message);
    // Handle error:
    // - Log to monitoring service
    // - Retry with exponential backoff
    // - Queue for later processing
    // - Notify admin
  } else {
    console.log("Email sent successfully:", result.id);
    // Store email ID for tracking
    // Update database record
    // Send confirmation
  }
}

// ============================================================================
// Real-World Use Cases
// ============================================================================

// 1. Welcome Email
async function sendWelcomeEmail(user: { email: string; name: string; id: string }) {
  const emailService = new EmailService();

  return await emailService.sendEmail({
    from: "noreply@example.com",
    to: { name: user.name, email: user.email },
    subject: "Welcome to ShipAPI App!",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #333;">Welcome, ${user.name}!</h1>
        <p>We're excited to have you on board.</p>
        <p>Get started by:</p>
        <ul>
          <li>Completing your profile</li>
          <li>Connecting your social accounts</li>
          <li>Exploring your dashboard</li>
        </ul>
        <a href="https://example.com/dashboard" 
           style="display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">
          Go to Dashboard
        </a>
      </div>
    `,
    tags: [
      { name: "type", value: "welcome" },
      { name: "user_id", value: String(user.id) },
    ],
  });
}

// 2. Password Reset
async function sendPasswordResetEmail(user: { email: string; name: string }, resetToken: string) {
  const emailService = new EmailService();
  const resetUrl = `https://example.com/reset-password?token=${resetToken}`;

  return await emailService.sendEmail({
    from: "noreply@example.com",
    to: user.email,
    replyTo: "support@example.com",
    subject: "Password Reset Request",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1>Password Reset</h1>
        <p>Hi ${user.name},</p>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <a href="${resetUrl}" 
           style="display: inline-block; padding: 12px 24px; background: #dc3545; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0;">
          Reset Password
        </a>
        <p style="color: #666;">This link will expire in 1 hour.</p>
        <p style="color: #666;">If you didn't request this, please ignore this email and your password will remain unchanged.</p>
      </div>
    `,
    tags: [{ name: "type", value: "password_reset" }],
  });
}

// 3. Email Verification
async function sendEmailVerification(
  user: { email: string; name: string },
  verificationToken: string,
) {
  const emailService = new EmailService();
  const verificationUrl = `https://example.com/verify-email?token=${verificationToken}`;

  return await emailService.sendEmail({
    from: "noreply@example.com",
    to: user.email,
    subject: "Verify Your Email Address",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1>Verify Your Email</h1>
        <p>Hi ${user.name},</p>
        <p>Please verify your email address by clicking the button below:</p>
        <a href="${verificationUrl}" 
           style="display: inline-block; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 4px; margin: 20px 0;">
          Verify Email
        </a>
        <p style="color: #666;">This link will expire in 24 hours.</p>
      </div>
    `,
    tags: [{ name: "type", value: "email_verification" }],
  });
}

// 4. Weekly Report
async function sendWeeklyReport(
  user: { email: string; name: string; id: string },
  reportData: any,
) {
  const emailService = new EmailService();

  return await emailService.sendEmail({
    from: "reports@example.com",
    to: user.email,
    subject: "Your Weekly Social Media Report",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h1>Weekly Report</h1>
        <p>Hi ${user.name},</p>
        <p>Here's your social media activity for the past week:</p>
        <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h2 style="margin-top: 0;">Key Metrics</h2>
          <ul style="list-style: none; padding: 0;">
            <li>📊 Total Engagements: ${reportData.engagements}</li>
            <li>👥 New Followers: ${reportData.followers}</li>
            <li>📝 Posts Published: ${reportData.posts}</li>
          </ul>
        </div>
        <a href="https://example.com/reports" 
           style="display: inline-block; padding: 12px 24px; background: #007bff; color: white; text-decoration: none; border-radius: 4px;">
          View Full Report
        </a>
      </div>
    `,
    tags: [
      { name: "type", value: "weekly_report" },
      { name: "user_id", value: String(user.id) },
    ],
  });
}

// 5. Bulk User Notifications
async function sendBulkNotifications(
  users: Array<{ email: string; name: string; id: string }>,
  notification: { subject: string; message: string },
) {
  const emailService = new EmailService();

  // Split into batches of 100
  const batches: (typeof users)[] = [];
  for (let i = 0; i < users.length; i += 100) {
    batches.push(users.slice(i, i + 100));
  }

  // Send each batch
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Sending batch ${i + 1} of ${batches.length}...`);

    const result = await emailService.sendBatchEmails({
      emails: batch.map((user) => ({
        from: "notifications@example.com",
        to: { name: user.name, email: user.email },
        subject: notification.subject,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <p>Hi ${user.name},</p>
            <p>${notification.message}</p>
          </div>
        `,
        tags: [
          { name: "type", value: "bulk_notification" },
          { name: "batch", value: String(i + 1) },
          { name: "user_id", value: String(user.id) },
        ],
      })),
    });

    if (result.error) {
      console.error(`Batch ${i + 1} failed:`, result.error);
    } else {
      console.log(`Batch ${i + 1} sent: ${result.data?.length} emails`);
    }

    // Add delay between batches to avoid rate limits
    if (i < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

// ============================================================================
// Using Default From Address
// ============================================================================

async function defaultFromExample() {
  // Set default from in constructor
  const emailService = new EmailService("test-key", "noreply@example.com");

  // Now you can omit "from" in sendEmail
  await emailService.sendEmail({
    to: "user@example.com",
    subject: "Test",
    text: "Test content",
  });

  // Change default from address
  emailService.setDefaultFrom("support@example.com");

  // This will now use support@example.com as the sender
  await emailService.sendEmail({
    to: "user@example.com",
    subject: "Support Message",
    text: "Support content",
  });
}

// ============================================================================
// Integration with Application
// ============================================================================

class UserNotificationService {
  constructor() {
    // Initialize EmailService with default from
    // In production, this would use the environment variable
  }

  async notifyNewSignup(user: { email: string; name: string; id: string }) {
    const result = await sendWelcomeEmail(user);

    if (result.error) {
      console.error("Failed to send welcome email:", result.error);
      // Log to monitoring service
      // Queue for retry
    } else {
      console.log("Welcome email sent:", result.id);
      // Store email ID in database
      // await db.emails.create({ userId: user.id, emailId: result.id, type: 'welcome' });
    }

    return result;
  }

  async notifyPasswordReset(user: { email: string; name: string }, token: string) {
    return await sendPasswordResetEmail(user, token);
  }

  async notifyEmailVerification(user: { email: string; name: string }, token: string) {
    return await sendEmailVerification(user, token);
  }

  async sendWeeklyReports(
    users: Array<{ email: string; name: string; id: string }>,
    getReportData: (userId: string) => Promise<any>,
  ) {
    for (const user of users) {
      try {
        const reportData = await getReportData(user.id);
        await sendWeeklyReport(user, reportData);
        console.log(`Sent report to ${user.email}`);
      } catch (error) {
        console.error(`Failed to send report to ${user.email}:`, error);
      }

      // Add delay between emails
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

// ============================================================================
// Email Templates
// ============================================================================

/**
 * Using email templates with the singleton EmailService instance
 * Templates are registered during application bootstrap
 */
async function templateExample() {
  // Get the singleton EmailService instance with all templates registered
  const emailService = getEmailService();

  // Send welcome email using template
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

  // Send import completion notification
  await emailService.sendEmailWithTemplate({
    templateId: "import-completion",
    to: "user@example.com",
    variables: {
      firstName: "John",
      importSource: "Twitter Followers",
      processedCount: 150,
      matchedAccountCount: 80,
      createdAccountCount: 50,
      matchedPersonCount: 90,
      createdPersonCount: 40,
      edgeCreatedCount: 120,
      rejectedCount: 10,
      viewImportUrl: "https://yourdomain.com/imports/12345",
    },
  });

  // Send password reset email
  await emailService.sendEmailWithTemplate({
    templateId: "password-reset",
    to: "user@example.com",
    variables: {
      firstName: "John",
      resetUrl: "https://yourdomain.com/reset-password?token=abc123",
      expiresIn: "1 hour",
    },
  });
}

/**
 * Batch sending with templates
 */
async function batchTemplateExample() {
  const emailService = getEmailService();

  const users = [
    { email: "user1@example.com", firstName: "John", lastName: "Doe" },
    { email: "user2@example.com", firstName: "Jane", lastName: "Smith" },
    { email: "user3@example.com", firstName: "Bob", lastName: "Johnson" },
  ];

  // Send welcome emails to multiple users using templates
  await emailService.sendBatchEmailsWithTemplates(
    users.map((user) => ({
      templateId: "welcome",
      to: user.email,
      variables: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
    })),
  );
}

/**
 * Registering custom templates
 */
async function customTemplateExample() {
  const emailService = new EmailService(); // For custom use case

  // Register a custom template
  emailService.registerTemplate({
    id: "order-confirmation",
    name: "Order Confirmation",
    subject: "Order Confirmation #{{orderNumber}}",
    html:
      "<h1>Thank you, {{customerName}}!</h1>" +
      "<p>Order #{{orderNumber}} confirmed</p>" +
      "<p>Total: ${{totalAmount}}</p>" +
      "{{#if hasDiscount}}" +
      "<p>Discount applied: {{discount}}%</p>" +
      "{{/if}}",
    text:
      "Thank you, {{customerName}}!\n" +
      "Order #{{orderNumber}} confirmed\n" +
      "Total: ${{totalAmount}}",
    tags: ["order", "confirmation"],
  });

  // Use the custom template
  await emailService.sendEmailWithTemplate({
    templateId: "order-confirmation",
    to: "customer@example.com",
    variables: {
      customerName: "Jane Smith",
      orderNumber: "ORD-12345",
      totalAmount: 99.99,
      hasDiscount: true,
      discount: 10,
    },
  });
}

/**
 * Preview template rendering without sending
 */
async function previewTemplateExample() {
  const emailService = getEmailService();

  // Render template to preview content
  const rendered = emailService.renderTemplate({
    templateId: "welcome",
    variables: {
      firstName: "John",
      lastName: "Doe",
      email: "john@example.com",
    },
  });

  console.log("Subject:", rendered.subject);
  console.log("HTML:", rendered.html);
  console.log("Text:", rendered.text);
}

/**
 * Integration example using templates
 */
class TemplateNotificationService {
  private emailService: EmailService;

  constructor() {
    // Get singleton instance with all templates registered
    this.emailService = getEmailService();
  }

  async notifyNewUser(user: { email: string; firstName: string; lastName: string }) {
    const result = await this.emailService.sendEmailWithTemplate({
      templateId: "welcome",
      to: user.email,
      variables: {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      },
    });

    if (result.error) {
      console.error("Failed to send welcome email:", result.error);
      throw result.error;
    }

    return result;
  }

  async notifyImportComplete(
    user: { email: string; firstName: string },
    importData: {
      source: string;
      processedCount: number;
      matchedAccountCount: number;
      createdAccountCount: number;
      matchedPersonCount: number;
      createdPersonCount: number;
      edgeCreatedCount: number;
      rejectedCount: number;
      viewUrl: string;
    },
  ) {
    return await this.emailService.sendEmailWithTemplate({
      templateId: "import-completion",
      to: user.email,
      variables: {
        firstName: user.firstName,
        importSource: importData.source,
        processedCount: importData.processedCount,
        matchedAccountCount: importData.matchedAccountCount,
        createdAccountCount: importData.createdAccountCount,
        matchedPersonCount: importData.matchedPersonCount,
        createdPersonCount: importData.createdPersonCount,
        edgeCreatedCount: importData.edgeCreatedCount,
        rejectedCount: importData.rejectedCount,
        viewImportUrl: importData.viewUrl,
      },
    });
  }

  async notifyImportFailed(
    user: { email: string; firstName: string },
    importData: { source: string; errorMessage: string },
  ) {
    return await this.emailService.sendEmailWithTemplate({
      templateId: "import-failed",
      to: user.email,
      variables: {
        firstName: user.firstName,
        importSource: importData.source,
        errorMessage: importData.errorMessage,
        supportUrl: "https://yourdomain.com/support",
      },
    });
  }
}

// Export examples
export {
  basicExample,
  advancedExample,
  batchExample,
  errorHandlingExample,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendEmailVerification,
  sendWeeklyReport,
  sendBulkNotifications,
  defaultFromExample,
  UserNotificationService,
  templateExample,
  batchTemplateExample,
  customTemplateExample,
  previewTemplateExample,
  TemplateNotificationService,
};
