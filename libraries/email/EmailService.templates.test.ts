import { beforeEach, describe, expect, it, vi } from "vitest";
import EmailService from "./EmailService.js";
import type { EmailTemplate } from "./types/index.js";

// Mock Resend
vi.mock("resend", () => {
  return {
    // vitest 4: `vi.fn()` respects the implementation's constructibility, so
    // the implementation must be a `function` expression for `new Resend()`.
    Resend: vi.fn(function () {
      return {
        emails: {
          send: vi.fn().mockResolvedValue({ data: { id: "mock-email-id" } }),
        },
        batch: {
          send: vi.fn().mockResolvedValue({
            data: { data: [{ id: "email-1" }, { id: "email-2" }] },
          }),
        },
      };
    }),
  };
});

describe("EmailService - Template Features", () => {
  let emailService: EmailService;

  beforeEach(() => {
    emailService = new EmailService("test-api-key", "noreply@test.com");
  });

  describe("Template Registration", () => {
    it("should register a template", () => {
      const template: EmailTemplate = {
        id: "test-template",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      emailService.registerTemplate(template);

      expect(emailService.hasTemplate("test-template")).toBe(true);
    });

    it("should register multiple templates", () => {
      const templates: EmailTemplate[] = [
        {
          id: "template1",
          name: "Template 1",
          subject: "Subject 1",
          text: "Body 1",
        },
        {
          id: "template2",
          name: "Template 2",
          subject: "Subject 2",
          text: "Body 2",
        },
      ];

      emailService.registerTemplates(templates);

      expect(emailService.hasTemplate("template1")).toBe(true);
      expect(emailService.hasTemplate("template2")).toBe(true);
    });

    it("should get a registered template", () => {
      const template: EmailTemplate = {
        id: "test-template",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      emailService.registerTemplate(template);

      const retrieved = emailService.getTemplate("test-template");

      expect(retrieved).toEqual(template);
    });

    it("should list all templates", () => {
      const templates: EmailTemplate[] = [
        {
          id: "template1",
          name: "Template 1",
          subject: "Subject 1",
          text: "Body 1",
        },
        {
          id: "template2",
          name: "Template 2",
          subject: "Subject 2",
          text: "Body 2",
        },
      ];

      emailService.registerTemplates(templates);

      const allTemplates = emailService.listTemplates();

      expect(allTemplates).toHaveLength(2);
    });

    it("should not auto-register templates", () => {
      const serviceWithoutTemplates = new EmailService("test-api-key", "noreply@test.com");

      expect(serviceWithoutTemplates.hasTemplate("welcome")).toBe(false);
      expect(serviceWithoutTemplates.hasTemplate("import-completion")).toBe(false);
      expect(serviceWithoutTemplates.hasTemplate("import-failed")).toBe(false);
    });
  });

  describe("Template Rendering", () => {
    beforeEach(() => {
      emailService.registerTemplate({
        id: "test-template",
        name: "Test Template",
        subject: "Hello {{firstName}}!",
        html: "<h1>Welcome {{firstName}} {{lastName}}!</h1>",
        text: "Welcome {{firstName}} {{lastName}}!",
      });
    });

    it("should render a template with variables", () => {
      const rendered = emailService.renderTemplate({
        templateId: "test-template",
        variables: {
          firstName: "John",
          lastName: "Doe",
        },
      });

      expect(rendered.subject).toBe("Hello John!");
      expect(rendered.html).toBe("<h1>Welcome John Doe!</h1>");
      expect(rendered.text).toBe("Welcome John Doe!");
    });

    it("should throw error if template not found", () => {
      expect(() =>
        emailService.renderTemplate({
          templateId: "nonexistent",
          variables: {},
        }),
      ).toThrow("Template with ID 'nonexistent' not found");
    });

    it("should override from address in rendering options", () => {
      const rendered = emailService.renderTemplate({
        templateId: "test-template",
        variables: { firstName: "John", lastName: "Doe" },
        from: "custom@example.com",
      });

      expect(rendered.from).toBe("custom@example.com");
    });

    it("should add additional tags in rendering options", () => {
      const rendered = emailService.renderTemplate({
        templateId: "test-template",
        variables: { firstName: "John", lastName: "Doe" },
        tags: ["custom-tag"],
      });

      expect(rendered.tags).toContainEqual({ name: "custom-tag", value: "custom-tag" });
    });
  });

  describe("Send Email with Template", () => {
    beforeEach(() => {
      emailService.registerTemplate({
        id: "welcome",
        name: "Welcome Email",
        subject: "Welcome {{firstName}}!",
        html: "<h1>Welcome {{firstName}} {{lastName}}!</h1>",
        text: "Welcome {{firstName}} {{lastName}}!",
      });
    });

    it("should send email using a template", async () => {
      const result = await emailService.sendEmailWithTemplate({
        templateId: "welcome",
        to: "user@example.com",
        variables: {
          firstName: "John",
          lastName: "Doe",
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBe("mock-email-id");
    });

    it("should handle template rendering errors", async () => {
      const result = await emailService.sendEmailWithTemplate({
        templateId: "nonexistent",
        to: "user@example.com",
        variables: {},
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("Template with ID 'nonexistent' not found");
    });

    it("should support cc, bcc, and other email options", async () => {
      const result = await emailService.sendEmailWithTemplate({
        templateId: "welcome",
        to: "user@example.com",
        cc: "manager@example.com",
        bcc: "admin@example.com",
        variables: {
          firstName: "John",
          lastName: "Doe",
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.id).toBe("mock-email-id");
    });
  });

  describe("Send Batch Emails with Templates", () => {
    beforeEach(() => {
      emailService.registerTemplate({
        id: "welcome",
        name: "Welcome Email",
        subject: "Welcome {{firstName}}!",
        text: "Welcome {{firstName}} {{lastName}}!",
      });
    });

    it("should send batch emails using templates", async () => {
      const result = await emailService.sendBatchEmailsWithTemplates([
        {
          templateId: "welcome",
          to: "user1@example.com",
          variables: { firstName: "John", lastName: "Doe" },
        },
        {
          templateId: "welcome",
          to: "user2@example.com",
          variables: { firstName: "Jane", lastName: "Smith" },
        },
      ]);

      expect(result.error).toBeUndefined();
      expect(result.data).toHaveLength(2);
    });

    it("should handle empty batch", async () => {
      const result = await emailService.sendBatchEmailsWithTemplates([]);

      expect(result.error).toBeUndefined();
      expect(result.data).toEqual([]);
    });

    it("should reject batches over 100 emails", async () => {
      const emails = Array(101)
        .fill(null)
        .map((_, i) => ({
          templateId: "welcome",
          to: `user${i}@example.com`,
          variables: { firstName: "User", lastName: String(i) },
        }));

      const result = await emailService.sendBatchEmailsWithTemplates(emails);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("Batch size cannot exceed 100 emails");
    });

    it("should handle template rendering errors in batch", async () => {
      const result = await emailService.sendBatchEmailsWithTemplates([
        {
          templateId: "nonexistent",
          to: "user1@example.com",
          variables: {},
        },
      ]);

      expect(result.error).toBeDefined();
    });
  });
});
