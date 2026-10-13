import { beforeEach, describe, expect, it } from "vitest";
import TemplateRegistry from "./TemplateRegistry.js";
import type { EmailTemplate } from "./types/index.js";

describe("TemplateRegistry", () => {
  let registry: TemplateRegistry;

  beforeEach(() => {
    registry = new TemplateRegistry();
  });

  describe("register", () => {
    it("should register a template", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      registry.register(template);

      expect(registry.has("test")).toBe(true);
      expect(registry.get("test")).toEqual(template);
    });

    it("should throw error if template ID already exists", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      registry.register(template);

      expect(() => registry.register(template)).toThrow("Template with ID 'test' already exists");
    });

    it("should throw error if template has no subject", () => {
      const template = {
        id: "test",
        name: "Test Template",
        text: "Test body",
      } as EmailTemplate;

      expect(() => registry.register(template)).toThrow("must have a subject");
    });

    it("should throw error if template has neither html nor text", () => {
      const template = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
      } as EmailTemplate;

      expect(() => registry.register(template)).toThrow("must have either html or text content");
    });

    it("should accept template with only html", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        html: "<h1>Test</h1>",
      };

      expect(() => registry.register(template)).not.toThrow();
    });

    it("should accept template with only text", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      expect(() => registry.register(template)).not.toThrow();
    });

    it("should accept template with both html and text", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        html: "<h1>Test</h1>",
        text: "Test body",
      };

      expect(() => registry.register(template)).not.toThrow();
    });
  });

  describe("registerMany", () => {
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

      registry.registerMany(templates);

      expect(registry.count()).toBe(2);
      expect(registry.has("template1")).toBe(true);
      expect(registry.has("template2")).toBe(true);
    });
  });

  describe("get", () => {
    it("should return template if it exists", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      registry.register(template);

      expect(registry.get("test")).toEqual(template);
    });

    it("should return undefined if template does not exist", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("getOrThrow", () => {
    it("should return template if it exists", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      registry.register(template);

      expect(registry.getOrThrow("test")).toEqual(template);
    });

    it("should throw error if template does not exist", () => {
      expect(() => registry.getOrThrow("nonexistent")).toThrow(
        "Template with ID 'nonexistent' not found",
      );
    });
  });

  describe("has", () => {
    it("should return true if template exists", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      registry.register(template);

      expect(registry.has("test")).toBe(true);
    });

    it("should return false if template does not exist", () => {
      expect(registry.has("nonexistent")).toBe(false);
    });
  });

  describe("unregister", () => {
    it("should remove a template", () => {
      const template: EmailTemplate = {
        id: "test",
        name: "Test Template",
        subject: "Test Subject",
        text: "Test body",
      };

      registry.register(template);
      expect(registry.has("test")).toBe(true);

      const removed = registry.unregister("test");

      expect(removed).toBe(true);
      expect(registry.has("test")).toBe(false);
    });

    it("should return false if template does not exist", () => {
      const removed = registry.unregister("nonexistent");

      expect(removed).toBe(false);
    });
  });

  describe("clear", () => {
    it("should remove all templates", () => {
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

      registry.registerMany(templates);
      expect(registry.count()).toBe(2);

      registry.clear();

      expect(registry.count()).toBe(0);
      expect(registry.has("template1")).toBe(false);
      expect(registry.has("template2")).toBe(false);
    });
  });

  describe("list", () => {
    it("should return all templates", () => {
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

      registry.registerMany(templates);

      const allTemplates = registry.list();

      expect(allTemplates).toHaveLength(2);
      expect(allTemplates).toEqual(expect.arrayContaining(templates));
    });

    it("should return empty array if no templates", () => {
      expect(registry.list()).toEqual([]);
    });
  });

  describe("listIds", () => {
    it("should return all template IDs", () => {
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

      registry.registerMany(templates);

      const ids = registry.listIds();

      expect(ids).toHaveLength(2);
      expect(ids).toContain("template1");
      expect(ids).toContain("template2");
    });

    it("should return empty array if no templates", () => {
      expect(registry.listIds()).toEqual([]);
    });
  });

  describe("count", () => {
    it("should return the number of templates", () => {
      expect(registry.count()).toBe(0);

      registry.register({
        id: "template1",
        name: "Template 1",
        subject: "Subject 1",
        text: "Body 1",
      });

      expect(registry.count()).toBe(1);

      registry.register({
        id: "template2",
        name: "Template 2",
        subject: "Subject 2",
        text: "Body 2",
      });

      expect(registry.count()).toBe(2);
    });
  });

  describe("findByTag", () => {
    it("should return templates with the specified tag", () => {
      const templates: EmailTemplate[] = [
        {
          id: "template1",
          name: "Template 1",
          subject: "Subject 1",
          text: "Body 1",
          tags: ["welcome", "onboarding"],
        },
        {
          id: "template2",
          name: "Template 2",
          subject: "Subject 2",
          text: "Body 2",
          tags: ["notification"],
        },
        {
          id: "template3",
          name: "Template 3",
          subject: "Subject 3",
          text: "Body 3",
          tags: ["welcome", "notification"],
        },
      ];

      registry.registerMany(templates);

      const welcomeTemplates = registry.findByTag("welcome");

      expect(welcomeTemplates).toHaveLength(2);
      expect(welcomeTemplates.map((t) => t.id)).toContain("template1");
      expect(welcomeTemplates.map((t) => t.id)).toContain("template3");
    });

    it("should return empty array if no templates have the tag", () => {
      registry.register({
        id: "template1",
        name: "Template 1",
        subject: "Subject 1",
        text: "Body 1",
        tags: ["welcome"],
      });

      const result = registry.findByTag("nonexistent");

      expect(result).toEqual([]);
    });

    it("should return empty array if no templates registered", () => {
      const result = registry.findByTag("welcome");

      expect(result).toEqual([]);
    });
  });
});
