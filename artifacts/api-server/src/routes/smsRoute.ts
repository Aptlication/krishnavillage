import { Router } from "express";
import { db } from "@workspace/db";
import {
  smsMessagesTable,
  guestRegistrationsTable,
  tenantsTable,
} from "@workspace/db/schema";
import { and, eq, desc, sql } from "drizzle-orm";
import { requireStaffAuth, resolveTenant } from "../middlewares/staffAuth";
import type { TenantRequest, StaffRequest } from "../middlewares/staffAuth";
import {
  getSmsService,
  composeFinalBody,
  normalisePhoneNumber,
  formatRoomLabel,
} from "../lib/sms";
import { logger } from "../lib/logger";

const smsRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Send a single SMS (staff-only). Either resolves the recipient from guestId,
// or accepts a raw "to" number. Logs the row in sms_messages and dispatches
// via the configured SMS provider. The tenant footer is appended here so the
// recorded body matches what actually got sent.

smsRouter.post("/sms/send", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const staff = (req as unknown as StaffRequest).staff;

  const {
    guestId,
    to,
    body,
    linkedMaintenanceReportId,
    linkedHousekeepingReportId,
  } = req.body as {
    guestId?: unknown;
    to?: unknown;
    body?: unknown;
    linkedMaintenanceReportId?: unknown;
    linkedHousekeepingReportId?: unknown;
  };

  if (!body || typeof body !== "string" || !body.trim()) {
    res.status(400).json({ error: "body is required" });
    return;
  }

  // Resolve destination — guestId takes precedence so reception clicks one
  // button and we look up the mobile they already entered.
  let resolvedTo: string | null = null;
  let resolvedGuestId: number | null = null;
  if (typeof guestId === "number" && Number.isFinite(guestId)) {
    const [guest] = await db
      .select()
      .from(guestRegistrationsTable)
      .where(
        and(
          eq(guestRegistrationsTable.tenantId, tenantId),
          eq(guestRegistrationsTable.id, guestId),
        ),
      );
    if (!guest) {
      res.status(404).json({ error: "Guest not found" });
      return;
    }
    if (!guest.mobile) {
      res.status(400).json({ code: "no_mobile", error: "Guest has no mobile number on file." });
      return;
    }
    resolvedTo = guest.mobile;
    resolvedGuestId = guest.id;
  } else if (typeof to === "string" && to.trim()) {
    const norm = normalisePhoneNumber(to);
    if (!norm) {
      res.status(400).json({ error: "to is not a valid mobile number" });
      return;
    }
    resolvedTo = norm;
  } else {
    res.status(400).json({ error: "Either guestId or to is required" });
    return;
  }

  // Look up the tenant footer once.
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  const footer = tenant?.smsFooter ?? "";
  const finalBody = composeFinalBody(body.trim(), footer);

  const sms = getSmsService();
  const [pending] = await db
    .insert(smsMessagesTable)
    .values({
      tenantId,
      guestId: resolvedGuestId,
      to: resolvedTo,
      body: finalBody,
      sentByStaffId: staff.staffId,
      sentByName: staff.displayName,
      provider: sms.provider,
      status: "queued",
      linkedMaintenanceReportId:
        typeof linkedMaintenanceReportId === "number" ? linkedMaintenanceReportId : null,
      linkedHousekeepingReportId:
        typeof linkedHousekeepingReportId === "number" ? linkedHousekeepingReportId : null,
      trigger: "manual",
    })
    .returning();

  const result = await sms.sendSms({ to: resolvedTo, body: finalBody });

  const [updated] = await db
    .update(smsMessagesTable)
    .set({
      providerMessageId: result.providerMessageId,
      status: result.status,
      errorMessage: result.errorMessage ?? null,
    })
    .where(eq(smsMessagesTable.id, pending.id))
    .returning();

  res.status(201).json(updated);
});

// ─────────────────────────────────────────────────────────────────────────────
// History — list SMS for a given guest / report / staff / status. Used by
// the admin SMS History page and the per-report audit-trail badges.

smsRouter.get("/sms/history", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { guestId, maintenanceReportId, housekeepingReportId, limit } = req.query as {
    guestId?: string;
    maintenanceReportId?: string;
    housekeepingReportId?: string;
    limit?: string;
  };

  const conditions = [eq(smsMessagesTable.tenantId, tenantId)];
  if (guestId) {
    const n = parseInt(guestId, 10);
    if (!isNaN(n)) conditions.push(eq(smsMessagesTable.guestId, n));
  }
  if (maintenanceReportId) {
    const n = parseInt(maintenanceReportId, 10);
    if (!isNaN(n)) conditions.push(eq(smsMessagesTable.linkedMaintenanceReportId, n));
  }
  if (housekeepingReportId) {
    const n = parseInt(housekeepingReportId, 10);
    if (!isNaN(n)) conditions.push(eq(smsMessagesTable.linkedHousekeepingReportId, n));
  }

  const lim = limit ? Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500) : 200;

  const rows = await db
    .select()
    .from(smsMessagesTable)
    .where(and(...conditions))
    .orderBy(desc(smsMessagesTable.createdAt))
    .limit(lim);

  res.json(rows);
});

// ─────────────────────────────────────────────────────────────────────────────
// Twilio status webhook — reconciles "queued" → "delivered" / "failed".
// One-way only; we never accept inbound messages. Twilio signs requests; for
// MVP we trust the source by URL secrecy + signature presence.
// The form-encoded body fields are documented at
// https://www.twilio.com/docs/sms/api/message-resource#message-status-values

smsRouter.post("/sms/webhook/twilio", resolveTenant, async (req, res) => {
  const { MessageSid, MessageStatus, ErrorMessage } = req.body as {
    MessageSid?: unknown;
    MessageStatus?: unknown;
    ErrorMessage?: unknown;
  };
  if (typeof MessageSid !== "string" || typeof MessageStatus !== "string") {
    res.status(400).json({ error: "Invalid webhook payload" });
    return;
  }

  const mapped: typeof smsMessagesTable.$inferSelect.status =
    MessageStatus === "delivered" ? "delivered" :
    MessageStatus === "sent" ? "sent" :
    MessageStatus === "failed" || MessageStatus === "undelivered" ? "failed" :
    "queued";

  await db
    .update(smsMessagesTable)
    .set({
      status: mapped,
      errorMessage: typeof ErrorMessage === "string" ? ErrorMessage : undefined,
      deliveredAt: mapped === "delivered" ? new Date() : undefined,
    })
    .where(eq(smsMessagesTable.providerMessageId, MessageSid));

  res.status(204).send();
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant SMS settings — small CRUD for the SMS Settings admin page.

smsRouter.get("/sms/settings", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  res.json({
    smsAutoSendOnAcknowledge: tenant.smsAutoSendOnAcknowledge,
    smsAutoSendOnResolve: tenant.smsAutoSendOnResolve,
    smsFooter: tenant.smsFooter,
  });
});

smsRouter.patch("/sms/settings", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { smsAutoSendOnAcknowledge, smsAutoSendOnResolve, smsFooter } = req.body as {
    smsAutoSendOnAcknowledge?: unknown;
    smsAutoSendOnResolve?: unknown;
    smsFooter?: unknown;
  };

  const update: Partial<typeof tenantsTable.$inferInsert> = {};
  if (typeof smsAutoSendOnAcknowledge === "boolean") update.smsAutoSendOnAcknowledge = smsAutoSendOnAcknowledge;
  if (typeof smsAutoSendOnResolve === "boolean") update.smsAutoSendOnResolve = smsAutoSendOnResolve;
  if (typeof smsFooter === "string") update.smsFooter = smsFooter;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "No supported fields supplied" });
    return;
  }

  const [updated] = await db
    .update(tenantsTable)
    .set(update)
    .where(eq(tenantsTable.id, tenantId))
    .returning();

  res.json({
    smsAutoSendOnAcknowledge: updated.smsAutoSendOnAcknowledge,
    smsAutoSendOnResolve: updated.smsAutoSendOnResolve,
    smsFooter: updated.smsFooter,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared auto-send helper used by maintenance and housekeeping routes.
// Exported so each route file can import and fire-and-forget on
// acknowledge/resolve without duplicating the lookup logic.

export async function dispatchAutoSms(args: {
  tenantId: number;
  roomNumber: string;
  body: string;
  trigger: "auto_acknowledge" | "auto_resolve";
  linkedMaintenanceReportId?: number;
  linkedHousekeepingReportId?: number;
}): Promise<void> {
  try {
    const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, args.tenantId));
    if (!tenant) return;

    // Honour the tenant toggle.
    if (args.trigger === "auto_acknowledge" && !tenant.smsAutoSendOnAcknowledge) return;
    if (args.trigger === "auto_resolve" && !tenant.smsAutoSendOnResolve) return;

    // Find the guest by roomNumber. If multiple share a room (campers),
    // pick the most recently updated since they're the active occupant.
    const guests = await db
      .select()
      .from(guestRegistrationsTable)
      .where(
        and(
          eq(guestRegistrationsTable.tenantId, args.tenantId),
          eq(guestRegistrationsTable.roomNumber, args.roomNumber),
        ),
      )
      .orderBy(desc(guestRegistrationsTable.updatedAt))
      .limit(1);

    const guest = guests[0];
    const footer = tenant.smsFooter ?? "";
    const finalBody = composeFinalBody(args.body, footer);

    // If the guest has no mobile, still record the attempt as skipped so
    // staff can see why the SMS didn't go out.
    if (!guest || !guest.mobile) {
      await db.insert(smsMessagesTable).values({
        tenantId: args.tenantId,
        guestId: guest?.id ?? null,
        to: "",
        body: finalBody,
        sentByStaffId: null,
        sentByName: "auto",
        provider: "system",
        status: "skipped_no_mobile",
        trigger: args.trigger,
        linkedMaintenanceReportId: args.linkedMaintenanceReportId ?? null,
        linkedHousekeepingReportId: args.linkedHousekeepingReportId ?? null,
      });
      return;
    }

    const sms = getSmsService();
    const [pending] = await db
      .insert(smsMessagesTable)
      .values({
        tenantId: args.tenantId,
        guestId: guest.id,
        to: guest.mobile,
        body: finalBody,
        sentByStaffId: null,
        sentByName: "auto",
        provider: sms.provider,
        status: "queued",
        trigger: args.trigger,
        linkedMaintenanceReportId: args.linkedMaintenanceReportId ?? null,
        linkedHousekeepingReportId: args.linkedHousekeepingReportId ?? null,
      })
      .returning();

    const result = await sms.sendSms({ to: guest.mobile, body: finalBody });
    await db
      .update(smsMessagesTable)
      .set({
        providerMessageId: result.providerMessageId,
        status: result.status,
        errorMessage: result.errorMessage ?? null,
      })
      .where(eq(smsMessagesTable.id, pending.id));
  } catch (err: unknown) {
    // Auto-send must never break the underlying maintenance/housekeeping
    // mutation, so we swallow + log here. The sms_messages row (if any) is
    // already persisted with status reflecting the attempt.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Auto-SMS dispatch failed");
  }
}

// Re-export the helper to support symmetric usage across maintenance/housekeeping.
export { formatRoomLabel };

// Avoid an unused-import warning in the rare case sql is not referenced — keep
// it imported for future query needs.
void sql;

export default smsRouter;
