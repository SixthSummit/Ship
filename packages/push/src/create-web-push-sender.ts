import webPush from "web-push";
import type {
  PushDeliveryResult,
  PushNotification,
  PushSendOptions,
  WebPushSender,
  WebPushSenderOptions,
  WebPushSubscription,
} from "./push-types.js";
import {
  notificationPayload,
  parsePushSubscription,
  validateSender,
  validateSendOptions,
} from "./push-validation.js";

/** Instance-scoped VAPID credentials. No global web-push configuration or automatic retries. */
export function createWebPushSender(options: WebPushSenderOptions): WebPushSender {
  const origins = [...validateSender(options)];
  const vapidDetails = { ...options.vapid };
  const timeout = options.timeoutMs ?? 10000;
  return Object.freeze({
    async send(
      subscription: WebPushSubscription,
      notification: PushNotification,
      sendOptions: PushSendOptions = {},
    ): Promise<PushDeliveryResult> {
      const target = parsePushSubscription(subscription, origins);
      const payload = notificationPayload(notification);
      validateSendOptions(sendOptions);
      try {
        const response = await webPush.sendNotification(target, payload, {
          vapidDetails,
          timeout,
          TTL: sendOptions.ttlSeconds ?? 3600,
          urgency: sendOptions.urgency ?? "normal",
          ...(sendOptions.topic === undefined ? {} : { topic: sendOptions.topic }),
        });
        return { status: "accepted", statusCode: response.statusCode };
      } catch (error: unknown) {
        // Provider errors contain subscription URLs, keys and response bodies. Never expose them.
        const response = error as {
          statusCode?: unknown;
          headers?: Record<string, unknown>;
        } | null;
        const code = response?.statusCode;
        if (typeof code !== "number" || !Number.isInteger(code) || code < 100 || code > 599)
          return { status: "retryable" };
        if (code === 404 || code === 410) return { status: "expired", statusCode: code };
        if (code === 429 || code >= 500) {
          const raw = response?.headers?.["retry-after"];
          const seconds = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
          return {
            status: "retryable",
            statusCode: code,
            ...(Number.isSafeInteger(seconds) ? { retryAfterSeconds: seconds } : {}),
          };
        }
        return { status: "rejected", statusCode: code };
      }
    },
  });
}
