import { utf8Bytes } from "@sixthsummit/ship-core";
import { describe, expect, it } from "vitest";
import {
  SLACK_SIGNATURE_HEADER,
  SLACK_TIMESTAMP_HEADER,
  slackSignatureHeaders,
  slackWebhookVerifier,
} from "./slack.js";

const secret = "slack_signing_secret";
const now = new Date("2026-09-18T12:00:00.000Z");
const body = utf8Bytes('{"type":"event_callback","event_id":"Ev123"}');
const verifier = slackWebhookVerifier();

function request(headers: Record<string, string>, rawBody = body, key = secret) {
  return {
    headers,
    rawBody,
    method: "POST",
    canonicalUrl: "https://api.example.test/webhooks/slack",
    secret: key,
    now,
  };
}

describe("slackWebhookVerifier", () => {
  it("verifies a v0 signature with its timestamp and reports the signed event id", async () => {
    expect(verifier.guarantees).toEqual({ signature: true, freshness: true, replay: false });
    expect(verifier.sensitiveHeaders).toEqual(["x-slack-signature"]);
    const headers = await slackSignatureHeaders({ secret, rawBody: body, timestamp: now });
    expect(headers[SLACK_SIGNATURE_HEADER]).toMatch(/^v0=[0-9a-f]{64}$/u);
    expect(headers[SLACK_TIMESTAMP_HEADER]).toBe("1789732800");
    await expect(verifier.verify(request({ ...headers }))).resolves.toEqual({
      ok: true,
      eventId: "Ev123",
      timestamp: now,
    });
    const form = utf8Bytes("token=abc&command=%2Fdeploy");
    const formHeaders = await slackSignatureHeaders({ secret, rawBody: form, timestamp: now });
    await expect(verifier.verify(request({ ...formHeaders }, form))).resolves.toEqual({
      ok: true,
      timestamp: now,
    });
  });

  it("rejects bad signatures, tampered content, wrong secrets, stale and missing timestamps", async () => {
    const headers = await slackSignatureHeaders({ secret, rawBody: body, timestamp: now });
    await expect(
      verifier.verify(request({ ...headers, [SLACK_SIGNATURE_HEADER]: `v0=${"1".repeat(64)}` })),
    ).resolves.toEqual({ ok: false, reason: "signature-mismatch" });
    await expect(verifier.verify(request({ ...headers }, utf8Bytes("{}")))).resolves.toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    await expect(verifier.verify(request({ ...headers }, body, "other"))).resolves.toEqual({
      ok: false,
      reason: "signature-mismatch",
    });
    const stale = await slackSignatureHeaders({
      secret,
      rawBody: body,
      timestamp: new Date(now.getTime() + 6 * 60_000),
    });
    await expect(verifier.verify(request({ ...stale }))).resolves.toEqual({
      ok: false,
      reason: "timestamp-stale",
    });
    await expect(verifier.verify(request({}))).resolves.toEqual({
      ok: false,
      reason: "missing-signature",
    });
    await expect(
      verifier.verify(
        request({ [SLACK_SIGNATURE_HEADER]: headers[SLACK_SIGNATURE_HEADER] as string }),
      ),
    ).resolves.toEqual({ ok: false, reason: "timestamp-missing" });
    await expect(
      verifier.verify(request({ ...headers, [SLACK_TIMESTAMP_HEADER]: "soon" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    await expect(
      verifier.verify(request({ ...headers, [SLACK_SIGNATURE_HEADER]: "v1=abcd" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
    await expect(
      verifier.verify(request({ ...headers, [SLACK_SIGNATURE_HEADER]: "v0=abcd" })),
    ).resolves.toEqual({ ok: false, reason: "malformed-signature" });
  });
});
