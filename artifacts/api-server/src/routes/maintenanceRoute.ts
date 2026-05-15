import { Router } from "express";
import { db } from "@workspace/db";
import { maintenanceReportsTable, insertMaintenanceReportSchema } from "@workspace/db/schema";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { requireStaffAuth, resolveTenant } from "../middlewares/staffAuth";
import type { TenantRequest, StaffRequest } from "../middlewares/staffAuth";
import { sendStaffMaintenanceAlert } from "../lib/staffPush";

const maintenanceRouter = Router();

// ─── Guest submit ─────────────────────────────────────────────────────────────
maintenanceRouter.post("/maintenance", resolveTenant, async (req, res) => {
  const parsed = insertMaintenanceReportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body", details: parsed.error.issues });
    return;
  }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { guestName, roomNumber, title, description, urgency, photos } = parsed.data;

  if (urgency !== "urgent" && urgency !== "non_urgent") {
    res.status(400).json({ error: "urgency must be 'urgent' or 'non_urgent'" });
    return;
  }

  const photoArray: string[] | null = photos ?? null;
  if (photoArray !== null && (!Array.isArray(photoArray) || photoArray.length > 3)) {
    res.status(400).json({ error: "photos must be an array of up to 3 base64 data URIs" });
    return;
  }

  const [report] = await db
    .insert(maintenanceReportsTable)
    .values({ source: "guest", guestName, roomNumber, title, description, urgency, photos: photoArray, tenantId })
    .returning();

  if (urgency === "urgent") {
    sendStaffMaintenanceAlert(tenantId, roomNumber, title).catch(() => {});
  }

  res.status(201).json({ id: report.id, status: report.status });
});

// ─── Guest: view my reports by room number ────────────────────────────────────
maintenanceRouter.get("/maintenance/my-reports", resolveTenant, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { roomNumber } = req.query as { roomNumber?: string };

  if (!roomNumber || typeof roomNumber !== "string" || !roomNumber.trim()) {
    res.status(400).json({ error: "roomNumber is required" });
    return;
  }

  const reports = await db
    .select({
      id: maintenanceReportsTable.id,
      title: maintenanceReportsTable.title,
      description: maintenanceReportsTable.description,
      urgency: maintenanceReportsTable.urgency,
      status: maintenanceReportsTable.status,
      resolutionNote: maintenanceReportsTable.resolutionNote,
      createdAt: maintenanceReportsTable.createdAt,
      resolvedAt: maintenanceReportsTable.resolvedAt,
    })
    .from(maintenanceReportsTable)
    .where(and(
      eq(maintenanceReportsTable.tenantId, tenantId),
      eq(maintenanceReportsTable.roomNumber, roomNumber.trim().toUpperCase()),
    ))
    .orderBy(desc(maintenanceReportsTable.createdAt))
    .limit(20);

  res.json(reports);
});

// ─── Staff create ─────────────────────────────────────────────────────────────
maintenanceRouter.post("/maintenance/staff", requireStaffAuth, async (req, res) => {
  const staff = (req as unknown as StaffRequest).staff;
  const tenantId = (req as unknown as TenantRequest).tenantId;

  const { roomNumber, title, description, urgency, photos } = req.body as {
    roomNumber?: unknown;
    title?: unknown;
    description?: unknown;
    urgency?: unknown;
    photos?: unknown;
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

  // Optional photo array (base64 data URIs, same format as guest-side reports)
  let photoArray: string[] | null = null;
  if (photos !== undefined && photos !== null) {
    if (!Array.isArray(photos) || !photos.every((p) => typeof p === "string")) {
      res.status(400).json({ error: "photos must be an array of strings" });
      return;
    }
    photoArray = (photos as string[]).slice(0, 5); // hard cap defence
  }

  const [report] = await db
    .insert(maintenanceReportsTable)
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
    })
    .returning();

  if (urgency === "urgent") {
    sendStaffMaintenanceAlert(tenantId, roomNumber as string, (title as string).trim()).catch(() => {});
  }

  res.status(201).json({ id: report.id, status: report.status });
});

// ─── List ─────────────────────────────────────────────────────────────────────
maintenanceRouter.get("/maintenance", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { status, resolution, from } = req.query as {
    status?: string;
    resolution?: string;
    from?: string;
  };

  const validStatuses = ["open", "in_progress", "resolved"];
  const validResolutions = ["actioned", "delegated"];

  const conditions = [eq(maintenanceReportsTable.tenantId, tenantId)];

  if (status && validStatuses.includes(status)) {
    conditions.push(eq(maintenanceReportsTable.status, status));
  }
  if (resolution && validResolutions.includes(resolution)) {
    conditions.push(eq(maintenanceReportsTable.resolution, resolution));
  }
  if (from) {
    const fromDate = new Date(from);
    if (!isNaN(fromDate.getTime())) {
      conditions.push(gte(maintenanceReportsTable.resolvedAt, fromDate));
    }
  }

  const reports = await db
    .select()
    .from(maintenanceReportsTable)
    .where(and(...conditions))
    .orderBy(desc(maintenanceReportsTable.createdAt));

  res.json(reports);
});

// ─── CSV Export (resolved) ────────────────────────────────────────────────────
maintenanceRouter.get("/maintenance/export", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { resolution, from, to } = req.query as { resolution?: string; from?: string; to?: string };

  const validResolutions = ["actioned", "delegated"];
  const conditions = [
    eq(maintenanceReportsTable.tenantId, tenantId),
    eq(maintenanceReportsTable.status, "resolved"),
  ];

  if (resolution && validResolutions.includes(resolution)) {
    conditions.push(eq(maintenanceReportsTable.resolution, resolution));
  }
  let fromDate: Date | undefined;
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) {
      fromDate = d;
      conditions.push(gte(maintenanceReportsTable.resolvedAt, d));
    }
  }
  let toDate: Date | undefined;
  if (to) {
    const d = new Date(to);
    if (!isNaN(d.getTime())) {
      // Include the full end day
      d.setHours(23, 59, 59, 999);
      toDate = d;
      conditions.push(lte(maintenanceReportsTable.resolvedAt, d));
    }
  }

  const reports = await db
    .select()
    .from(maintenanceReportsTable)
    .where(and(...conditions))
    .orderBy(desc(maintenanceReportsTable.resolvedAt));

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

  // Build a descriptive filename based on filters
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
  const filename = `maintenance-history${filenameSuffix}.csv`;
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ─── Acknowledge → In Progress ────────────────────────────────────────────────
maintenanceRouter.patch("/maintenance/:id/acknowledge", requireStaffAuth, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const staff = (req as unknown as StaffRequest).staff;
  const { inProgressNote } = req.body as { inProgressNote?: string };

  const [existing] = await db
    .select()
    .from(maintenanceReportsTable)
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  if (existing.status !== "open") { res.status(409).json({ error: "Report is not in 'open' status" }); return; }

  const note = typeof inProgressNote === "string" && inProgressNote.trim() ? inProgressNote.trim() : null;

  const [updated] = await db
    .update(maintenanceReportsTable)
    .set({
      status: "in_progress",
      inProgressAt: new Date(),
      inProgressByStaffId: staff.staffId,
      inProgressByName: staff.displayName,
      inProgressNote: note,
    })
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)))
    .returning();

  res.json(updated);
});

// ─── Resolve & Sign Off ───────────────────────────────────────────────────────
maintenanceRouter.patch("/maintenance/:id/resolve", requireStaffAuth, async (req, res) => {
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
    .from(maintenanceReportsTable)
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  if (existing.status === "resolved") { res.status(409).json({ error: "Report is already resolved" }); return; }

  const note = typeof resolutionNote === "string" && resolutionNote.trim() ? resolutionNote.trim() : null;

  const [updated] = await db
    .update(maintenanceReportsTable)
    .set({
      status: "resolved",
      resolution,
      resolvedAt: new Date(),
      resolvedByStaffId: staff.staffId,
      resolvedByName: staff.displayName,
      resolutionNote: note,
    })
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)))
    .returning();

  res.json(updated);
});

// ─── Update resolution note ───────────────────────────────────────────────────
maintenanceRouter.patch("/maintenance/:id/note", requireStaffAuth, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const staff = (req as unknown as StaffRequest).staff;
  const { resolutionNote } = req.body as { resolutionNote?: string | null };

  const [existing] = await db
    .select()
    .from(maintenanceReportsTable)
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }
  if (existing.status !== "resolved") { res.status(409).json({ error: "Report is not resolved" }); return; }

  const note =
    resolutionNote === null || resolutionNote === undefined
      ? null
      : typeof resolutionNote === "string" && resolutionNote.trim()
        ? resolutionNote.trim()
        : null;

  const [updated] = await db
    .update(maintenanceReportsTable)
    .set({
      resolutionNote: note,
      resolutionNoteEditedByName: staff.displayName,
      resolutionNoteEditedAt: new Date(),
    })
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)))
    .returning();

  res.json(updated);
});

// ─── Escalate urgency ─────────────────────────────────────────────────────────
maintenanceRouter.patch("/maintenance/:id/urgency", requireStaffAuth, async (req, res) => {
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
    .from(maintenanceReportsTable)
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)));

  if (!existing) { res.status(404).json({ error: "Report not found" }); return; }

  const [updated] = await db
    .update(maintenanceReportsTable)
    .set({ urgency: urgency as string })
    .where(and(eq(maintenanceReportsTable.tenantId, tenantId), eq(maintenanceReportsTable.id, id)))
    .returning();

  if (existing.urgency !== "urgent" && urgency === "urgent") {
    sendStaffMaintenanceAlert(tenantId, existing.roomNumber, existing.title).catch(() => {});
  }

  res.json(updated);
});

export default maintenanceRouter;
