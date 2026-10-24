import { defineMailer, type MailRendering } from "@sixthsummit/ship-core";
import { z } from "zod";
import { InvalidCredentialAuthDefinitionError } from "./errors.js";

export const credentialMailPayloadSchema = z.object({
  /** The recipient's email, for the greeting. */
  email: z.string().email(),
  /** The single-use link the consumer built from the token. */
  url: z.string().url(),
  appName: z.string().min(1),
});

export type CredentialMailPayload = z.infer<typeof credentialMailPayloadSchema>;
export type CredentialMailMessage =
  | "verifyEmail"
  | "resetPassword"
  | "changeEmail"
  | "existingAccount"
  | "passwordChanged";

export interface CredentialAuthMailerOptions<TId extends string = "auth.mailer"> {
  /** Must be namespaced by the auth module id (`<moduleId>.mailer`). Defaults to `auth.mailer`. */
  readonly id?: TId;
  readonly from?: string;
  readonly replyTo?: string;
  /** Shown in subjects and bodies. */
  readonly appName: string;
  /** Replace any default template; the payload is the same for every message. */
  readonly templates?: Partial<
    Record<CredentialMailMessage, (payload: CredentialMailPayload) => MailRendering>
  >;
}

const defaultTemplates: Record<
  CredentialMailMessage,
  (payload: CredentialMailPayload) => MailRendering
> = {
  verifyEmail: ({ url, appName }) => ({
    subject: `Verify your email for ${appName}`,
    html: `<p>Confirm this email address for ${escapeHtml(appName)} by opening the link below. It expires soon and works once.</p><p><a href="${escapeHtml(url)}">Verify email</a></p><p>If you did not create an account, ignore this message.</p>`,
    text: `Confirm this email address for ${appName} by opening the link below. It expires soon and works once.\n\n${url}\n\nIf you did not create an account, ignore this message.`,
  }),
  resetPassword: ({ url, appName }) => ({
    subject: `Reset your ${appName} password`,
    html: `<p>Someone asked to reset the password for this ${escapeHtml(appName)} account. Open the link below to choose a new one. It expires soon and works once.</p><p><a href="${escapeHtml(url)}">Reset password</a></p><p>If this was not you, ignore this message; your password is unchanged.</p>`,
    text: `Someone asked to reset the password for this ${appName} account. Open the link below to choose a new one. It expires soon and works once.\n\n${url}\n\nIf this was not you, ignore this message; your password is unchanged.`,
  }),
  changeEmail: ({ url, appName }) => ({
    subject: `Confirm your new ${appName} email`,
    html: `<p>Confirm that this is the new email address for your ${escapeHtml(appName)} account. It expires soon and works once.</p><p><a href="${escapeHtml(url)}">Confirm email change</a></p>`,
    text: `Confirm that this is the new email address for your ${appName} account. It expires soon and works once.\n\n${url}`,
  }),
  existingAccount: ({ url, appName }) => ({
    subject: `You already have a ${appName} account`,
    html: `<p>Someone tried to create a ${escapeHtml(appName)} account with this email address, but it already has one. If that was you, sign in instead; if you forgot your password, reset it from the sign-in page.</p><p><a href="${escapeHtml(url)}">Sign in</a></p><p>If this was not you, no action is needed; nothing about your account changed.</p>`,
    text: `Someone tried to create a ${appName} account with this email address, but it already has one. If that was you, sign in instead; if you forgot your password, reset it from the sign-in page.\n\n${url}\n\nIf this was not you, no action is needed; nothing about your account changed.`,
  }),
  passwordChanged: ({ url, appName }) => ({
    subject: `Your ${appName} password was changed`,
    html: `<p>The password for your ${escapeHtml(appName)} account was just changed and your other sessions were signed out.</p><p>If that was you, there is nothing to do.</p><p>If it was not you, take the account back now: the link below lets you set a new password and signs every session out. It expires in a few minutes and works once.</p><p><a href="${escapeHtml(url)}">Secure my account</a></p>`,
    text: `The password for your ${appName} account was just changed and your other sessions were signed out.\n\nIf that was you, there is nothing to do.\n\nIf it was not you, take the account back now: the link below lets you set a new password and signs every session out. It expires in a few minutes and works once.\n\n${url}`,
  }),
};

/**
 * The five messages the credential flows send. Declare the result on the
 * auth module (the module does this for you) and register it with
 * `defineMailDelivery({ mailers })`.
 */
export function defineCredentialAuthMailer<const TId extends string = "auth.mailer">(
  options: CredentialAuthMailerOptions<TId>,
) {
  if (typeof options?.appName !== "string" || options.appName.trim().length === 0) {
    throw new InvalidCredentialAuthDefinitionError(
      "SHIP_AUTH_MAILER_INVALID",
      "credential auth mailer needs an appName",
      { field: "appName" },
    );
  }
  const id = (options.id ?? "auth.mailer") as TId;
  const template = (name: CredentialMailMessage) =>
    options.templates?.[name] ?? defaultTemplates[name];
  return defineMailer({
    id,
    ...(options.from !== undefined ? { from: options.from } : {}),
    ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
    messages: {
      verifyEmail: {
        payload: credentialMailPayloadSchema,
        description: "Sent after registration and on every re-request.",
        sample: {
          email: "ada@example.test",
          url: "https://app.example.test/verify/sample",
          appName: options.appName,
        },
        render: template("verifyEmail"),
      },
      resetPassword: {
        payload: credentialMailPayloadSchema,
        description: "Sent when a password reset is requested for an existing account.",
        sample: {
          email: "ada@example.test",
          url: "https://app.example.test/reset/sample",
          appName: options.appName,
        },
        render: template("resetPassword"),
      },
      changeEmail: {
        payload: credentialMailPayloadSchema,
        description: "Sent to the new address when a signed-in account changes its email.",
        sample: {
          email: "ada@example.test",
          url: "https://app.example.test/email/sample",
          appName: options.appName,
        },
        render: template("changeEmail"),
      },
      existingAccount: {
        payload: credentialMailPayloadSchema,
        description:
          "Sent to an address that registers again while it already has a verified account (onExistingEmail: conceal); links to the sign-in page.",
        sample: {
          email: "ada@example.test",
          url: "https://app.example.test/sign-in",
          appName: options.appName,
        },
        render: template("existingAccount"),
      },
      passwordChanged: {
        payload: credentialMailPayloadSchema,
        description:
          "Sent to the account's address after a password change; carries a short-lived reset link so the owner can retake the account if the change was not theirs.",
        sample: {
          email: "ada@example.test",
          url: "https://app.example.test/reset/sample",
          appName: options.appName,
        },
        render: template("passwordChanged"),
      },
    },
  });
}

export type CredentialAuthMailer<TId extends string = string> = ReturnType<
  typeof defineCredentialAuthMailer<TId>
>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
