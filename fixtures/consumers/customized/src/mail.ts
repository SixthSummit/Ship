import { defineMailer } from "@sixthsummit/ship-core";
import { z } from "zod";

/**
 * The application's one mailer. Templates are pure functions of the validated
 * payload, so the same code renders the development preview, the unit test
 * and the production send; delivery is `mail.deliver` in `application.ts`.
 */
export const reportsMailer = defineMailer({
  id: "reports.mailer",
  from: "Portfolio Reports <reports@example.test>",
  replyTo: "support@example.test",
  messages: {
    digestReady: {
      payload: z.object({
        tenantId: z.string().trim().min(1),
        period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
        projectCount: z.number().int().nonnegative(),
      }),
      description: "Tells a tenant that the daily portfolio digest is ready.",
      sample: { tenantId: "acme", period: "2026-09-18", projectCount: 3 },
      render: ({ tenantId, period, projectCount }) => ({
        subject: `Portfolio digest for ${period}`,
        html: `<h1>Digest ready</h1><p>${projectCount} project${projectCount === 1 ? "" : "s"} summarized for ${escapeHtml(tenantId)} on ${period}.</p>`,
        text: `Digest ready: ${projectCount} project${projectCount === 1 ? "" : "s"} summarized for ${tenantId} on ${period}.`,
      }),
    },
  },
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
