import { beforeEach, describe, expect, it, vi } from "vitest";
import EmailService from "./EmailService.js";
import type { SendEmailOptions } from "./types/index.js";

// Mock the Resend client
vi.mock("resend", () => {
  return {
    // vitest 4: `vi.fn()` respects the implementation's constructibility, so
    // the implementation must be a `function` expression for `new Resend()`.
    Resend: vi.fn(function () {
      return {
        emails: {
          send: vi.fn(),
        },
        batch: {
          send: vi.fn(),
        },
      };
    }),
  };
});

describe("EmailService", () => {
  let emailService: EmailService;
  let mockResend: any;

  beforeEach(() => {
    emailService = new EmailService("test-api-key", "test@example.com");
    mockResend = (emailService as any).resend;
  });

  describe("constructor", () => {
    it("should initialize with injected API key + default from", () => {
      expect(emailService).toBeDefined();
    });

    it("should throw error if no API key provided", () => {
      // Create a service with empty API key
      expect(() => new EmailService("", "")).toThrow("Resend API key is required");
    });

    it("should accept custom API key and default from", () => {
      const service = new EmailService("custom-key", "custom@example.com");
      expect(service.getDefaultFrom()).toBe("custom@example.com");
    });
  });

  describe("sendEmail", () => {
    it("should send a simple text email", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(result.error).toBeUndefined();
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "Test Email",
          text: "Test content",
        }),
      );
    });

    it("should send an HTML email", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
        html: "<h1>Test</h1>",
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<h1>Test</h1>",
        }),
      );
    });

    it("should handle multiple recipients", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: ["recipient1@example.com", "recipient2@example.com"],
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: ["recipient1@example.com", "recipient2@example.com"],
        }),
      );
    });

    it("should handle named recipients", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        from: { name: "Sender Name", email: "sender@example.com" },
        to: [{ name: "Recipient Name", email: "recipient@example.com" }],
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Sender Name <sender@example.com>",
          to: ["Recipient Name <recipient@example.com>"],
        }),
      );
    });

    it("should use default from address if not provided", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        to: "recipient@example.com",
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "test@example.com",
        }),
      );
    });

    it("should return error if from address is missing", async () => {
      // Create a new service with no default from - this should throw
      expect(() => new EmailService("test-key", "")).toThrow("Default from address is required");
    });

    it("should handle CC and BCC", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        cc: "cc@example.com",
        bcc: ["bcc1@example.com", "bcc2@example.com"],
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: ["cc@example.com"],
          bcc: ["bcc1@example.com", "bcc2@example.com"],
        }),
      );
    });

    it("should handle reply-to", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        replyTo: "reply@example.com",
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          replyTo: ["reply@example.com"],
        }),
      );
    });

    it("should handle attachments, tags, and headers", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
        text: "Test content",
        attachments: [
          {
            filename: "test.pdf",
            content: Buffer.from("test"),
            contentType: "application/pdf",
          },
        ],
        tags: [{ name: "type", value: "test" }],
        headers: { "X-Custom": "value" },
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: options.attachments,
          tags: options.tags,
          headers: options.headers,
        }),
      );
    });

    it("should handle scheduled emails", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: { id: "email-123" },
        error: null,
      });

      const scheduledAt = "2025-12-31T23:59:59Z";

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
        text: "Test content",
        scheduledAt,
      };

      const result = await emailService.sendEmail(options);

      expect(result.id).toBe("email-123");
      expect(mockResend.emails.send).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledAt,
        }),
      );
    });

    it("should handle Resend API errors", async () => {
      mockResend.emails.send.mockResolvedValue({
        data: null,
        error: { message: "API Error" },
      });

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe("API Error");
      expect(result.id).toBeUndefined();
    });

    it("should handle unexpected errors", async () => {
      mockResend.emails.send.mockRejectedValue(new Error("Network error"));

      const options: SendEmailOptions = {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
        text: "Test content",
      };

      const result = await emailService.sendEmail(options);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe("Network error");
    });
  });

  describe("sendBatchEmails", () => {
    it("should send batch emails successfully", async () => {
      mockResend.batch.send.mockResolvedValue({
        data: {
          data: [{ id: "email-1" }, { id: "email-2" }],
        },
        error: null,
      });

      const result = await emailService.sendBatchEmails({
        emails: [
          {
            from: "sender@example.com",
            to: "recipient1@example.com",
            subject: "Test 1",
            text: "Content 1",
          },
          {
            from: "sender@example.com",
            to: "recipient2@example.com",
            subject: "Test 2",
            text: "Content 2",
          },
        ],
      });

      expect(result.data).toHaveLength(2);
      expect(result.data?.[0].id).toBe("email-1");
      expect(result.data?.[1].id).toBe("email-2");
      expect(result.error).toBeUndefined();
    });

    it("should use default from for batch emails", async () => {
      mockResend.batch.send.mockResolvedValue({
        data: {
          data: [{ id: "email-1" }],
        },
        error: null,
      });

      await emailService.sendBatchEmails({
        emails: [
          {
            to: "recipient@example.com",
            subject: "Test",
            text: "Content",
          },
        ],
      });

      expect(mockResend.batch.send).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            from: "test@example.com",
          }),
        ]),
      );
    });

    it("should reject batch with more than 100 emails", async () => {
      const emails = Array(101)
        .fill(null)
        .map((_, i) => ({
          from: "sender@example.com",
          to: `recipient${i}@example.com`,
          subject: "Test",
          text: "Content",
        }));

      const result = await emailService.sendBatchEmails({ emails });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("cannot exceed 100");
    });

    it("should handle empty batch", async () => {
      const result = await emailService.sendBatchEmails({ emails: [] });

      expect(result.data).toEqual([]);
      expect(result.error).toBeUndefined();
    });

    it("should handle batch API errors", async () => {
      mockResend.batch.send.mockResolvedValue({
        data: null,
        error: { message: "Batch error" },
      });

      const result = await emailService.sendBatchEmails({
        emails: [
          {
            from: "sender@example.com",
            to: "recipient@example.com",
            subject: "Test",
            text: "Content",
          },
        ],
      });

      expect(result.error).toBeDefined();
      expect(result.error?.message).toBe("Batch error");
    });
  });

  describe("defaultFrom management", () => {
    it("should get default from address", () => {
      expect(emailService.getDefaultFrom()).toBe("test@example.com");
    });

    it("should set default from address", () => {
      emailService.setDefaultFrom("new@example.com");
      expect(emailService.getDefaultFrom()).toBe("new@example.com");
    });
  });
});
