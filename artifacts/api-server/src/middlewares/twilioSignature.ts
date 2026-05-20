/**
 * Twilio webhook signature verification middleware.
 *
 * Twilio signs every webhook call with HMAC-SHA1 over (full URL + alphabetically
 * sorted POST parameters), keyed with the account's Auth Token, then sends the
 * base64-encoded result in the `X-Twilio-Signature` header. This middleware
 * recomputes the signature and rejects any request that does not match, so a
 * third party who guesses the webhook URL cannot spoof status updates onto
 * sms_messages rows.
 *
 * Algorithm reference: https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Notes:
 *   - The request URL must match what Twilio actually called byte-for-byte.
 *     When the api-server runs behind a TLS-terminating proxy, Express's
 *     `req.protocol` + `Host` header may not match — set TWILIO_WEBHOOK_BASE_URL
 *     to the exact public URL Twilio was configured with (without trailing
 *     slash) and we'll prefer it.
 *   - `crypto.timingSafeEqual` is used for the comparison so we don't leak
 *     signature contents through timing.
 *   - When `TWILIO_AUTH_TOKEN` is unset (local dev / dry-run / CI), the
 *     middleware passes the request through with a warning so non-Twilio
 *     environments aren't broken. Production must always have it set.
 */
import type { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { logger } from "../lib/logger";

const TWILIO_AUTH_TOKEN = process.env["TWILIO_AUTH_TOKEN"];
const TWILIO_WEBHOOK_BASE_URL = process.env["TWILIO_WEBHOOK_BASE_URL"];

/**
 * Reconstruct the URL Twilio called. Twilio includes the full URL (with
 * scheme, host, path, and any query string) in the signature input.
 */
function reconstructUrl(req: Request): string {
  if (TWILIO_WEBHOOK_BASE_URL) {
    // Strip trailing slash on the base, ensure leading slash on the path,
    // then concatenate. originalUrl preserves any query string.
    const base = TWILIO_WEBHOOK_BASE_URL.replace(/\/+$/, "");
    const path = req.originalUrl.startsWith("/") ? req.originalUrl : `/${req.originalUrl}`;
    return `${base}${path}`;
  }
  // Honour x-forwarded-proto when the proxy populates it, otherwise fall back
  // to req.protocol. Host comes from the Host header (or x-forwarded-host).
  const fwdProto = req.headers["x-forwarded-proto"];
  const proto =
    typeof fwdProto === "string" ? fwdProto.split(",")[0]!.trim() :
    Array.isArray(fwdProto) ? fwdProto[0]! :
    req.protocol;
  const fwdHost = req.headers["x-forwarded-host"];
  const host =
    typeof fwdHost === "string" ? fwdHost.split(",")[0]!.trim() :
    Array.isArray(fwdHost) ? fwdHost[0]! :
    req.get("host") ?? "";
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Compute the expected signature for a given URL + form body using the
 * supplied Auth Token. Exposed for unit testing.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
): string {
  // Sort POST param names alphabetically and append `${name}${value}` for each.
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    const raw = params[key];
    // Twilio sends only strings; coerce defensively for anything that
    // sneaks through Express's body parser.
    const value =
      raw === null || raw === undefined ? "" :
      typeof raw === "string" ? raw :
      String(raw);
    data += key + value;
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * Express middleware. Apply ahead of any handler that mutates state in
 * response to a Twilio webhook.
 */
export function verifyTwilioSignature(req: Request, res: Response, next: NextFunction): void {
  // Dev / dry-run convenience: if Twilio creds aren't configured we treat the
  // endpoint as open. Production deployments must set TWILIO_AUTH_TOKEN.
  if (!TWILIO_AUTH_TOKEN) {
    if (process.env["NODE_ENV"] === "production") {
      logger.error("[twilioSignature] TWILIO_AUTH_TOKEN missing in production — rejecting webhook");
      res.status(503).json({ error: "Webhook verification not configured" });
      return;
    }
    logger.warn("[twilioSignature] TWILIO_AUTH_TOKEN unset — skipping signature check (dev only)");
    next();
    return;
  }

  const provided = req.headers["x-twilio-signature"];
  const providedStr = typeof provided === "string" ? provided : Array.isArray(provided) ? provided[0] : undefined;
  if (!providedStr) {
    logger.warn({ ip: req.ip }, "[twilioSignature] Missing X-Twilio-Signature header");
    res.status(401).json({ error: "Missing X-Twilio-Signature" });
    return;
  }

  const url = reconstructUrl(req);
  const params = (req.body ?? {}) as Record<string, unknown>;
  const expected = computeTwilioSignature(TWILIO_AUTH_TOKEN, url, params);

  // Timing-safe comparison. Both sides must be Buffers of the same length;
  // any length mismatch is treated as failure without calling timingSafeEqual.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(providedStr, "utf8");
  const ok = a.length === b.length && timingSafeEqual(a, b);

  if (!ok) {
    logger.warn(
      { url, providedPreview: providedStr.slice(0, 8), expectedPreview: expected.slice(0, 8) },
      "[twilioSignature] Signature mismatch — rejecting webhook",
    );
    res.status(401).json({ error: "Invalid Twilio signature" });
    return;
  }

  next();
}
