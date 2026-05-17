/**
 * SMS service — provider-agnostic interface with a Twilio implementation as
 * the default. The api-server depends on the SmsService interface so swapping
 * to MessageMedia / ClickSend / AWS SNS later is a single-file change.
 *
 * When Twilio credentials are missing (dev/CI), the service falls back to a
 * console-logging "dry-run" implementation so flows that depend on it still
 * succeed locally without burning real credits.
 */
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Public types

export interface SmsSendInput {
  /** E.164 destination (e.g. +61412345678). */
  to: string;
  /** Final message body. The caller is responsible for appending the tenant footer. */
  body: string;
  /** Optional idempotency key — currently unused, reserved for retry safety. */
  idempotencyKey?: string;
}

export interface SmsSendResult {
  providerMessageId: string | null;
  status: "queued" | "sent" | "delivered" | "failed" | "undelivered";
  errorMessage?: string;
}

export interface SmsService {
  /** Provider name recorded on each sms_messages row. */
  readonly provider: string;
  sendSms(input: SmsSendInput): Promise<SmsSendResult>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone-number normalisation
//
// We accept loose user input (spaces, leading 0, +61, 61, etc.) and store
// E.164. To avoid pulling libphonenumber-js (~150kB) into the api-server, we
// implement a small AU-focused normaliser that handles the realistic cases
// reception will see. International numbers are accepted verbatim provided
// they're already in E.164 format.

const DEFAULT_REGION = (process.env["TENANT_DEFAULT_REGION"] ?? "AU").toUpperCase();

/**
 * Normalise a phone number to E.164. Returns null if the input cannot be
 * confidently coerced into a valid mobile number.
 *
 * Examples (AU default region):
 *   "0412 345 678"   → "+61412345678"
 *   "0412-345-678"   → "+61412345678"
 *   "+61 412 345 678"→ "+61412345678"
 *   "61412345678"    → "+61412345678"
 *   "+1 415 5550100" → "+14155550100" (already international, passes through)
 *   "12345"          → null
 */
export function normalisePhoneNumber(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!cleaned) return null;

  // Already E.164
  if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;

  // AU-specific: leading 0 → +61, then drop the 0
  if (DEFAULT_REGION === "AU") {
    if (/^0\d{9}$/.test(cleaned)) return `+61${cleaned.slice(1)}`;
    if (/^61\d{9}$/.test(cleaned)) return `+${cleaned}`;
  }

  // Other regions: bare digits become +<region-prefix><digits> only if a sane
  // prefix is configured. Conservative — return null to force reception to
  // enter the number in international format.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Twilio implementation
//
// Uses fetch directly against the Twilio REST API so we don't add a hard
// dependency on the `twilio` SDK to the workspace. The SDK is a thin wrapper
// around the same endpoint; if we ever want webhook signature verification
// done by the SDK we can switch later.

const TWILIO_ACCOUNT_SID = process.env["TWILIO_ACCOUNT_SID"];
const TWILIO_AUTH_TOKEN = process.env["TWILIO_AUTH_TOKEN"];
const TWILIO_FROM_NUMBER = process.env["TWILIO_FROM_NUMBER"]; // e.g. "+61..." or "KrishnaVlg"

class TwilioSmsService implements SmsService {
  readonly provider = "twilio";

  async sendSms(input: SmsSendInput): Promise<SmsSendResult> {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

    const params = new URLSearchParams();
    params.set("To", input.to);
    params.set("From", TWILIO_FROM_NUMBER ?? "");
    params.set("Body", input.body);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        logger.warn({ status: res.status, errBody, to: input.to }, "Twilio SMS send failed");
        return {
          providerMessageId: null,
          status: "failed",
          errorMessage: `Twilio ${res.status}: ${errBody.slice(0, 200)}`,
        };
      }

      const data = (await res.json()) as { sid: string; status: string };
      // Twilio status values map roughly to ours; treat anything we don't
      // recognise as "queued" since the webhook will reconcile it later.
      const mappedStatus: SmsSendResult["status"] =
        data.status === "delivered" ? "delivered" :
        data.status === "sent" ? "sent" :
        data.status === "failed" || data.status === "undelivered" ? "failed" :
        "queued";

      return { providerMessageId: data.sid, status: mappedStatus };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg, to: input.to }, "Twilio SMS send threw");
      return { providerMessageId: null, status: "failed", errorMessage: msg };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run fallback for dev / CI when Twilio creds are missing.

class DryRunSmsService implements SmsService {
  readonly provider = "dryrun";

  async sendSms(input: SmsSendInput): Promise<SmsSendResult> {
    logger.info(
      { to: input.to, bodyPreview: input.body.slice(0, 120) },
      "[SMS:dryrun] Would have sent SMS (no provider credentials configured)",
    );
    // We claim "sent" so flows in dev show the green path; the row in
    // sms_messages records provider="dryrun" so it's clearly distinguishable.
    return { providerMessageId: `dryrun-${Date.now()}`, status: "sent" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level singleton

let _smsService: SmsService | null = null;

export function getSmsService(): SmsService {
  if (_smsService) return _smsService;
  const providerEnv = (process.env["SMS_PROVIDER"] ?? "twilio").toLowerCase();
  if (providerEnv === "twilio" && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER) {
    _smsService = new TwilioSmsService();
    logger.info({ provider: "twilio", from: TWILIO_FROM_NUMBER }, "SMS service initialised");
  } else {
    _smsService = new DryRunSmsService();
    logger.warn(
      { providerEnv, hasSid: !!TWILIO_ACCOUNT_SID, hasToken: !!TWILIO_AUTH_TOKEN, hasFrom: !!TWILIO_FROM_NUMBER },
      "SMS service falling back to dry-run — Twilio credentials missing or incomplete",
    );
  }
  return _smsService;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for callers

/**
 * Render the auto-acknowledge / auto-resolve templates approved in the plan.
 * The {firstName}, {roomLabel}, {staffName}, {kind} placeholders are filled in;
 * the tenant footer is appended by the caller (so manual sends share the same
 * trailing block).
 */
/**
 * Build the ETA phrase that gets woven into the acknowledgement SMS.
 * Honours the "estimate only" disclaimer the user requested so
 * guests don't take the time as a hard commitment.
 *
 * Returns null when both inputs are empty — caller skips the phrase entirely.
 */
export function formatEtaPhrase(
  etaHours: number | null | undefined,
  etaText: string | null | undefined,
): string | null {
  if (typeof etaHours === "number" && Number.isFinite(etaHours) && etaHours > 0) {
    const unit = etaHours === 1 ? "hour" : "hours";
    return `estimated within ${etaHours} ${unit} (estimate only)`;
  }
  const trimmed = (etaText ?? "").trim();
  if (trimmed) {
    // "Other" free-text. Add the disclaimer in brackets so the framing is
    // consistent regardless of what reception types.
    return `estimated ${trimmed} (estimate only)`;
  }
  return null;
}

export function renderAcknowledgeTemplate(args: {
  firstName: string;
  kind: "maintenance" | "housekeeping";
  roomLabel: string;
  staffName: string;
  etaPhrase?: string | null;
}): string {
  const teamWord = args.kind === "maintenance" ? "Maintenance" : "Housekeeping";
  // When an ETA is present we extend the first sentence with a clause; when
  // it isn't, the original wording is preserved exactly.
  const etaClause = args.etaPhrase ? `, ${args.etaPhrase}` : "";
  return (
    `Hi ${args.firstName}, your ${args.kind} request for ${args.roomLabel} ` +
    `is in the pipeline and is being actioned by ${args.staffName} from ${teamWord}${etaClause}. ` +
    `You will receive further confirmation of processing soon!`
  );
}

export function renderResolveTemplate(args: {
  firstName: string;
  kind: "maintenance" | "housekeeping";
  roomLabel: string;
  staffName: string;
}): string {
  const teamWord = args.kind === "maintenance" ? "Maintenance" : "Housekeeping";
  return (
    `Hi ${args.firstName}, your ${args.kind} request for ${args.roomLabel} ` +
    `has been actioned by ${args.staffName} from ${teamWord}.`
  );
}

/**
 * Derive a short first name from the registered name field.
 * Reception currently records "Sharma" or "Anita Sharma" inconsistently;
 * splitting on whitespace and taking the first non-empty token works for both.
 */
export function deriveFirstName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[0] ?? fullName.trim();
}

/**
 * Friendly room label that matches what guests see on their booking:
 *   roomNumber starts with CAMP- → "campsite CAMP-001"
 *   accommodationType === "cabin" → "Cabin 4"
 *   default → "Room 12"
 */
export function formatRoomLabel(roomNumber: string, accommodationType: string | null | undefined): string {
  const num = (roomNumber ?? "").trim();
  if (accommodationType === "camping_site" || num.toUpperCase().startsWith("CAMP-")) {
    return `campsite ${num}`;
  }
  if (accommodationType === "cabin") return `Cabin ${num}`;
  return `Room ${num}`;
}

/**
 * Compose the final outbound body: template + blank line + tenant footer.
 * Centralised here so manual and auto sends are guaranteed consistent.
 */
export function composeFinalBody(body: string, footer: string): string {
  const trimmed = body.trimEnd();
  const trimmedFooter = footer.trim();
  if (!trimmedFooter) return trimmed;
  return `${trimmed}\n\n${trimmedFooter}`;
}
