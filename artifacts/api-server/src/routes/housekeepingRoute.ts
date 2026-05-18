import { Router } from "express";
import { db } from "@workspace/db";
import { housekeepingReportsTable, guestRegistrationsTable } from "@workspace/db/schema";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { requireStaffAuth, resolveTenant } from "../middlewares/staffAuth";
import type { TenantRequest, StaffRequest } from "../middlewares/staffAuth";
import { dispatchAutoSms } from "./smsRoute";
import {
  normalisePhoneNumber,
  renderAcknowledgeTemplate,
  renderResolveTemplate,
  deriveFirstName,
  formatRoomLabel,
  formatEtaPhrase,
} from "../lib/sms";

const VALID_ETA_HOURS = [1, 2, 4, 24, 48] as const;

/**
 * Pull the "[Acknowledged by: Name]" / "[Signed: Name]" tag off the note the
 * client prepends. Returns null if no tag is present. Mirrors the helper in
 * maintenanceRoute so behaviour stays identical between the two pipelines.
 */
function extractStaffSignature(note: string | null | undefined): string | null {
  if (!note) return null;
  const m = /\[(?:Acknowledged by|Signed):\s*([^\]]+)\]/.exec(note);
  return m && m[1] ? m[1].trim() : null;
}

const housekeepingRouter = Router();

// ─── Staff create ─────────────────────────────────────────────────────────────
// Housekeeping requests are staff-only; there is no guest-side submit endpoint.
housekeepingRouter.post("/housekeeping/staff", requireStaffAuth, async (req, res) => {
  const staff = (req as unknown as StaffRequest).staff;
  const tenantId = (req as unknown as TenantRequest).tenantId;

  const { roomNumber, title, description, urgency, photos, guestId, guestSurname, guestMobile } = req.body as {
    roomNumber?: unknown;
    title?: unknown;
    description?: unknown;
    urgency?: unknown;
    photos?: unknown;
    guestId?: unknown;
    guestSurname?: unknown;
    guestMobile?: unknown;
  };

  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!description || typeof description !== "string" || !description.trim()) {
    res.status(400).json({ error: "description is required" });
    return;
  }
  if (!roomNumber || typeof roomNumber !== "string" || !roomNumber.trim()) {
    res.status(400).json({ error: "roomNumber is required" });
    return;
  }
  if (urgency !== "urgent" && urgency !== "non_urgent") {
    res.status(400).json({ error: "urgency must be 'urgent' or 'non_urgent'" });
    return;
  }

  let photoArray: string[] | null = null;
  if (photos !== undefined && photos !== null) {
    if (!Array.isArray(photos) || !photos.every((p) => typeof p === "string")) {
      res.status(400).json({ error: "photos must be an array of strings" });
      return;
    }
    photoArray = (photos as string[]).slice(0, 5);
  }

  const [report] = await db
    .insert(housekeepingReportsTable)
    .values({
      source: "staff",
      guestName: staff.displayName,
      roomNumber: roomNumber as string,
      title: (title as string).trim(),
      description: (description as string).trim(),
      urgency: urgency as string,
      photos: photoArray,
      openedByStaffId: staff.staffId,
      openedByName: staff.displayName,
      tenantId,
      // Optional guest attribution captured by the staff Register-Guest picker
      // in the create dialog, or skipped entirely for unattributed jobs.
      guestId: typeof guestId === "number" && Number.isFinite(guestId) ? guestId : null,
      guestSurname: typeof guestSurname === "string" && guestSurname.trim() ? guestSurname.trim() : null,
      guestMobile: typeof guestMobile === "string" && guestMobile.trim()
        ? (normalisePhoneNumber(guestMobile) ?? null)
        : null,
    })
    .returning();

  res.status(201).json({ id: report.id, status: report.status });
});

// ─── Guest submit ─────────────────────────────────────────────────────────────
// Mirrors POST /maintenance — guests can raise housekeeping requests from the
// mobile PWA, with mandatory surname + mobile so auto-SMS can always reach them.
housekeepingRouter.post("/housekeeping", resolveTenant, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const {
    guestName,
    roomNumber,
    title,
    description,
    urgency,
    photos,
    guestSurname: rawGuestSurname,
    guestMobile: rawGuestMobile,
  } = req.body as {
    guestName?: unknown;
    roomNumber?: unknown;
    title?: unknown;
    description?: unknown;
    urgency?: unknown;
    photos?: unknown;
    guestSurname?: unknown;
    guestMobile?: unknown;
  };

  if (!guestName || typeof guestName !== "string" || !guestName.trim()) {
    res.status(400).json({ error: "guestName is required" });
    return;
  }
  if (!roomNumber || typeof roomNumber !== "string" || !roomNumber.trim()) {
    res.status(400).json({ error: "roomNumber is required" });
    return;
  }
  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!description || typeof description !== "string" || !description.trim()) {
    res.status(400).json({ error: "description is required" });
    return;
  }
  if (urgency !== "urgent" && urgency !== "non_urgent") {
    res.status(400).json({ error: "urgency must be 'urgent' or 'non_urgent'" });
    return;
  }

  const guestSurname = typeof rawGuestSurname === "string" ? rawGuestSurname.trim() : "";
  const normalisedMobile = normalisePhoneNumber(typeof rawGuestMobile === "string" ? rawGuestMobile : null);
  if (!guestSurname) {
    res.status(400).json({
      code: "guest_surname_required",
      error: "Your surname is required so housekeeping can attribute and respond to this request.",
    });
    return;
  }
  if (!normalisedMobile) {
    res.status(400).json({
      code: "mobile_required",
      error: "A valid mobile number is required so we can SMS you status updates.",
    });
    return;
  }

  let photoArray: string[] | null = null;
  if (photos !== undefined && photos !== null) {
    if (!Array.isArray(photos) || !photos.every((p) => typeof p === "string")) {
      res.status(400).json({ error: "photos must be an array of strings" });
      return;
    }
    photoArray = (photos as string[]).slice(0, 5);
  }

  // Best-effort link to the existing guest registration via roomNumber.
  const matches = await db
    .select({ id: guestRegistrationsTable.id })
    .from(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.roomNumber, roomNumber.trim().toUpperCase()),
      ),
    );
  const linkedGuestId = matches[0]?.id ?? null;

  const [report] = await db
    .insert(housekeepingReportsTable)
    .values({
      source: "guest",
      guestName: guestName.trim(),
      roomNumber: roomNumber.trim().toUpperCase(),
      title: title.trim(),
      description: description.trim(),
      urgency,
      photos: photoArray,
      tenantId,
      guestId: linkedGuestId,
      guestSurname,
      guestMobile: normalisedMobile,
    })
    .returning();

  res.status(201).json({ id: report.id, status: report.status });
});

// ─── List ─────────────────────────────────────────────────────────────────────
housekeepingRouter.get("/housekeeping", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { status, resolution, from } = req.query as {
    status?: string;
    resolution?: string;
    from?: string;
  };

  const validStatuses = ["open", "in_progress", "resolved"];
  const validResolutions = ["actioned", "delegated"];

  const conditions = [eq(housekeepingReportsTable.tenantId, tenantId)];

  if (status && validStatuses.includes(status)) {
    conditions.push(eq(housekeepingReportsTable.status, status));
  }
  if (resolution && validResolutions.includes(resolution)) {
    conditions.push(eq(housekeepingReportsTable.resolution, resolution));
  }
  if (from) {
    const fromDate = new Date(from);
    if (!isNaN(fromDate.getTime())) {
      conditions.push(gte(housekeepingReportsTable.resolvedAt, fromDate));
    }
  }

  const reports = await db
    .select()
    .from(housekeepingReportsTable)
    .where(and(...conditions))
    .orderBy(desc(housekeepingReportsTable.createdAt));

  res.json(reports);
});

// ─── CSV Export (resolved) ────────────────────────────────────────────────────
housekeepingRouter.get("/housekeeping/export", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { resolution, from, to } = req.query as { resolution?: string; from?: string; to?: string };

  const validResolutions = ["actioned", "delegated"];
  const conditions = [
    eq(housekeepingReportsTable.tenantId, tenantId),
    eq(housekeepingReportsTable.status, "resolved"),
  ];

  if (resolution && validResolutions.includes(resolution)) {
    conditions.push(eq(housekeepingReportsTable.resolution, resolution));
  }
  let fromDate: Date | undefined;
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) {
      fromDate = d;
      conditions.push(gte(housekeepingReportsTable.resolvedAt, d));
    }
  }
  let toDate: Date | undefined;
  if (to) {
    const d = new Date(to);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      toDate = d;
      conditions.push(lte(housekeepingReportsTable.resolvedAt, d));
    }
  }

  const reports = await db
    .select()
    .from(housekeepingReportsTable)
    .where(and(...conditions))
    .orderBy(desc(housekeepingReportsTable.resolvedAt));

  const FORMULA_PREFIXES = /^[=+\-@\t\r]/;

  function csvEscape(value: string | null | undefined): string {
    if (value == null) return "";
    let str = String(value);
    if (FORMULA_PREFIXES.test(str)) str = `'${str}`;
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const header = ["Date", "Room", "Title", "Urgency", "Resolution", "Resolved At", "Resolved By", "Resolution Note"].join(",");
  const rows = reports.map((r) =>
    [
      csvEscape(r.createdAt ? new Date(r.createdAt).toISOString() : null),
      csvEscape(r.roomNumber),
      csvEscape(r.title),
      csvEscape(r.urgency === "urgent" ? "Urgent" : "Non-urgent"),
      csvEscape(r.resolution === "actioned" ? "Actioned" : r.resolution === "delegated" ? "Delegated" : r.resolution),
      csvEscape(r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null),
      csvEscape(r.resolvedByName),
      csvEscape(r.resolutionNote),
    ].join(","),
  );

  const csv = [header, ...rows].join("\r\n");

  let filenameSuffix = "";
  if (fromDate && toDate) {
    const f = fromDate.toISOString().slice(0, 10);
    const t = toDate.toISOString().slice(0, 10);
    filenameSuffix = f === t ? `-${f}` : `-${f}-to-${t}`;
  } else if (fromDate) {
    filenameSuffix = `-from-${fromDate.toISOString().slice(0, 10)}`;
  } else if (toDate) {
    filenameSuffix = `-to-${toDate.toISOString().slice(0, 10)}`;
  } else {
    filenameSuffix = `-${new Date().toISOString().slice(0, 10)}`;
  }
  if (resolution && validResolutions.includes(resolution)) {
    filenameSuffix += `-${resolution}`;
  }
  const filename = `housekeeping-history${filenameSuffix}.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ─── Acknowledge → In Progress ────────────────────────────────────────────────
housekeepingRouter.patch("/housekeeping/:id/acknowledge", requireStaffAuth, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const staff = (req as unknown as StaffRequest).staff;
  const { inProgressNote, etaHours, etaText } = req.body as {
    inProgressNote?: string;
    etaHours?: unknown;
    etaText?: unknown;
  };

  const [existing] = await db
    .select()
    .from(housekeepingReportsTable)
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  if (existing.status !== "open") { res.status(409).json({ error: "Report is not in 'open' status" }); return; }

  const note = typeof inProgressNote === "string" && inProgressNote.trim() ? inProgressNote.trim() : null;

  // ETA: preset hour value (1/2/4/24/48) or free-text from "Other". Mirrors
  // the validation in maintenanceRoute so behaviour is identical.
  const presetEtaHours =
    typeof etaHours === "number" && (VALID_ETA_HOURS as readonly number[]).includes(etaHours)
      ? etaHours
      : null;
  const otherEtaText =
    !presetEtaHours && typeof etaText === "string" && etaText.trim() ? etaText.trim() : null;

  const [updated] = await db
    .update(housekeepingReportsTable)
    .set({
      status: "in_progress",
      inProgressAt: new Date(),
      inProgressByStaffId: staff.staffId,
      inProgressByName: staff.displayName,
      inProgressNote: note,
      etaHours: presetEtaHours,
      etaText: otherEtaText,
    })
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)))
    .returning();

  // Auto-send acknowledgement SMS — fire-and-forget.
  const ackStaffName = extractStaffSignature(updated.inProgressNote) ?? staff.displayName;
  const ackBody = renderAcknowledgeTemplate({
    firstName: deriveFirstName(updated.guestName),
    kind: "housekeeping",
    roomLabel: formatRoomLabel(updated.roomNumber, null),
    staffName: ackStaffName,
    etaPhrase: formatEtaPhrase(updated.etaHours, updated.etaText),
  });
  void dispatchAutoSms({
    tenantId,
    roomNumber: updated.roomNumber,
    body: ackBody,
    trigger: "auto_acknowledge",
    linkedHousekeepingReportId: updated.id,
    reportGuestId: updated.guestId,
    reportGuestMobile: updated.guestMobile,
  });

  res.json(updated);
});

// ─── Resolve & Sign Off ───────────────────────────────────────────────────────
housekeepingRouter.patch("/housekeeping/:id/resolve", requireStaffAuth, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const staff = (req as unknown as StaffRequest).staff;
  const { resolution, resolutionNote } = req.body as { resolution?: string; resolutionNote?: string };

  if (resolution !== "actioned" && resolution !== "delegated") {
    res.status(400).json({ error: "resolution must be 'actioned' or 'delegated'" });
    return;
  }

  const [existing] = await db
    .select()
    .from(housekeepingReportsTable)
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  if (existing.status === "resolved") { res.status(409).json({ error: "Report is already resolved" }); return; }

  const note = typeof resolutionNote === "string" && resolutionNote.trim() ? resolutionNote.trim() : null;

  const [updated] = await db
    .update(housekeepingReportsTable)
    .set({
      status: "resolved",
      resolution,
      resolvedAt: new Date(),
      resolvedByStaffId: staff.staffId,
      resolvedByName: staff.displayName,
      resolutionNote: note,
    })
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)))
    .returning();

  // Auto-send sign-off SMS — fire-and-forget.
  const signOffStaffName = extractStaffSignature(updated.resolutionNote) ?? staff.displayName;
  const resolveBody = renderResolveTemplate({
    firstName: deriveFirstName(updated.guestName),
    kind: "housekeeping",
    roomLabel: formatRoomLabel(updated.roomNumber, null),
    staffName: signOffStaffName,
  });
  void dispatchAutoSms({
    tenantId,
    roomNumber: updated.roomNumber,
    body: resolveBody,
    trigger: "auto_resolve",
    linkedHousekeepingReportId: updated.id,
    reportGuestId: updated.guestId,
    reportGuestMobile: updated.guestMobile,
  });

  res.json(updated);
});

// ─── Update resolution note ───────────────────────────────────────────────────
housekeepingRouter.patch("/housekeeping/:id/note", requireStaffAuth, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const staff = (req as unknown as StaffRequest).staff;
  const { resolutionNote } = req.body as { resolutionNote?: string | null };

  const [existing] = await db
    .select()
    .from(housekeepingReportsTable)
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  if (existing.status !== "resolved") { res.status(409).json({ error: "Report is not resolved" }); return; }

  const note =
    resolutionNote === null || resolutionNote === undefined
      ? null
      : typeof resolutionNote === "string" && resolutionNote.trim()
        ? resolutionNote.trim()
        : null;

  const [updated] = await db
    .update(housekeepingReportsTable)
    .set({
      resolutionNote: note,
      resolutionNoteEditedByName: staff.displayName,
      resolutionNoteEditedAt: new Date(),
    })
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)))
    .returning();

  res.json(updated);
});

// ─── Escalate urgency ─────────────────────────────────────────────────────────
housekeepingRouter.patch("/housekeeping/:id/urgency", requireStaffAuth, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { urgency } = req.body as { urgency?: unknown };

  if (urgency !== "urgent" && urgency !== "non_urgent") {
    res.status(400).json({ error: "urgency must be 'urgent' or 'non_urgent'" });
    return;
  }

  const [existing] = await db
    .select()
    .from(housekeepingReportsTable)
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }

  const [updated] = await db
    .update(housekeepingReportsTable)
    .set({ urgency: urgency as string })
    .where(and(eq(housekeepingReportsTable.tenantId, tenantId), eq(housekeepingReportsTable.id, id)))
    .returning();

  res.json(updated);
});

export default housekeepingRouter;
