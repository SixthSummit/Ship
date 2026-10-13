import { describe, expect, it } from "vitest";
import TemplateRenderer from "./TemplateRenderer.js";
import type { EmailTemplate } from "./types/index.js";

describe("TemplateRenderer", () => {
  const renderer = new TemplateRenderer();

  describe("Simple variable substitution", () => {
    it("should render simple variables", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Hello {{firstName}}",
        text: "Welcome {{firstName}} {{lastName}}!",
      };

      const result = renderer.render(template, {
        firstName: "John",
        lastName: "Doe",
      });

      expect(result.subject).toBe("Hello John");
      expect(result.text).toBe("Welcome John Doe!");
    });

    it("should render nested object properties", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Hello {{user.firstName}}",
        text: "Email: {{user.email}}",
      };

      const result = renderer.render(template, {
        user: {
          firstName: "Jane",
          email: "jane@example.com",
        },
      });

      expect(result.subject).toBe("Hello Jane");
      expect(result.text).toBe("Email: jane@example.com");
    });

    it("should render array indexing", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "First item: {{items.0.name}}",
        text: "Second item: {{items.1.name}}",
      };

      const result = renderer.render(template, {
        items: [{ name: "Item 1" }, { name: "Item 2" }],
      });

      expect(result.subject).toBe("First item: Item 1");
      expect(result.text).toBe("Second item: Item 2");
    });

    it("should return empty string for missing variables", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Hello {{missingVar}}",
        text: "Value: {{nested.missing.value}}",
      };

      const result = renderer.render(template, {});

      expect(result.subject).toBe("Hello ");
      expect(result.text).toBe("Value: ");
    });
  });

  describe("Conditional rendering", () => {
    it("should render conditional blocks when condition is truthy", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#if showWelcome}}Welcome!{{/if}}",
      };

      const result = renderer.render(template, { showWelcome: true });

      expect(result.text).toBe("Welcome!");
    });

    it("should not render conditional blocks when condition is falsy", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "Start{{#if showWelcome}}Welcome!{{/if}}End",
      };

      const result = renderer.render(template, { showWelcome: false });

      expect(result.text).toBe("StartEnd");
    });

    it("should handle nested conditionals", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#if user.isActive}}Active{{/if}}",
      };

      const result = renderer.render(template, {
        user: { isActive: true },
      });

      expect(result.text).toBe("Active");
    });

    it("should treat empty strings as falsy", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#if emptyString}}Should not show{{/if}}",
      };

      const result = renderer.render(template, { emptyString: "" });

      expect(result.text).toBe("");
    });

    it("should treat non-zero numbers as truthy", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#if count}}Has items{{/if}}",
      };

      const result = renderer.render(template, { count: 5 });

      expect(result.text).toBe("Has items");
    });

    it("should treat zero as falsy", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#if count}}Has items{{/if}}",
      };

      const result = renderer.render(template, { count: 0 });

      expect(result.text).toBe("");
    });
  });

  describe("Loop rendering", () => {
    it("should render loops with array items", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#each items}}{{this.name}} {{/each}}",
      };

      const result = renderer.render(template, {
        items: [{ name: "Item 1" }, { name: "Item 2" }, { name: "Item 3" }],
      });

      expect(result.text).toBe("Item 1 Item 2 Item 3 ");
    });

    it("should provide @index in loops", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#each items}}{{@index}}: {{this.name}} {{/each}}",
      };

      const result = renderer.render(template, {
        items: [{ name: "A" }, { name: "B" }],
      });

      expect(result.text).toBe("0: A 1: B ");
    });

    it("should provide @first and @last in loops", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#each items}}{{#if @first}}First{{/if}}{{#if @last}}Last{{/if}} {{/each}}",
      };

      const result = renderer.render(template, {
        items: [{ name: "A" }, { name: "B" }, { name: "C" }],
      });

      // First item should show "First ", middle should be " ", last should be "Last "
      expect(result.text).toBe("First  Last ");
    });

    it("should return empty string for non-array values", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{#each notAnArray}}{{this}}{{/each}}",
      };

      const result = renderer.render(template, {
        notAnArray: "string value",
      });

      expect(result.text).toBe("");
    });

    it("should return empty string for empty arrays", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "Start{{#each items}}{{this}}{{/each}}End",
      };

      const result = renderer.render(template, { items: [] });

      expect(result.text).toBe("StartEnd");
    });
  });

  describe("Helper functions", () => {
    it("should format numbers with formatNumber helper", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "Count: {{formatNumber count}}",
      };

      const result = renderer.render(template, { count: 1000000 });

      expect(result.text).toBe("Count: 1,000,000");
    });

    it("should format dates with formatDate helper", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "Date: {{formatDate date}}",
      };

      const date = new Date("2025-01-15");
      const result = renderer.render(template, { date });

      expect(result.text).toMatch(/Date: January 1\d, 2025/);
    });

    it("should pluralize with pluralize helper", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Test",
        text: "{{count}} {{pluralize count 'item' 'items'}}",
      };

      const result1 = renderer.render(template, { count: 1 });
      expect(result1.text).toBe("1 item");

      const result2 = renderer.render(template, { count: 5 });
      expect(result2.text).toBe("5 items");

      const result3 = renderer.render(template, { count: 0 });
      expect(result3.text).toBe("0 items");
    });
  });

  describe("Complex templates", () => {
    it("should render template with mixed features", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test",
        subject: "Order for {{user.name}}",
        html:
          "<h1>Hello {{user.name}}!</h1>" +
          "<p>You ordered {{formatNumber orderCount}} {{pluralize orderCount 'item' 'items'}}.</p>" +
          "{{#if hasDiscount}}<p>Discount applied: {{discount}}%</p>{{/if}}" +
          "<ul>{{#each items}}<li>{{@index}}. {{this.name}} - ${{this.price}}</li>{{/each}}</ul>",
      };

      const result = renderer.render(template, {
        user: { name: "John Doe" },
        orderCount: 3,
        hasDiscount: true,
        discount: 10,
        items: [
          { name: "Product A", price: 10 },
          { name: "Product B", price: 20 },
          { name: "Product C", price: 30 },
        ],
      });

      expect(result.subject).toBe("Order for John Doe");
      expect(result.html).toContain("Hello John Doe!");
      expect(result.html).toContain("You ordered 3 items.");
      expect(result.html).toContain("Discount applied: 10%");
      expect(result.html).toContain("0. Product A - $10");
      expect(result.html).toContain("1. Product B - $20");
      expect(result.html).toContain("2. Product C - $30");
    });
  });

  describe("Template metadata", () => {
    it("should include template metadata in result", () => {
      const template: EmailTemplate = {
        id: "test-template",
        name: "Test Template",
        subject: "Test",
        text: "Test",
        from: "noreply@example.com",
        replyTo: "support@example.com",
        tags: ["test", "welcome"],
      };

      const result = renderer.render(template, {});

      expect(result.templateId).toBe("test-template");
      expect(result.from).toBe("noreply@example.com");
      expect(result.replyTo).toBe("support@example.com");
      expect(result.tags).toHaveLength(2);
    });
  });
});
