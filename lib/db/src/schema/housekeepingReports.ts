import { pgTable, text, serial, timestamp, json, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const housekeepingReportsTable = pgTable("housekeeping_reports", {
  id: serial("id").primaryKey(),
  // Who raised the issue
  source: text("source").notNull().default("staff"), // "guest" | "staff"
  guestName: text("guest_name").notNull(),
  roomNumber: text("room_number").notNull(),
  openedByStaffId: integer("opened_by_staff_id"),
  openedByName: text("opened_by_name"),
  // Issue details
  title: text("title").notNull(),
  description: text("description").notNull(),
  urgency: text("urgency").notNull(), // "urgent" | "non_urgent"
  photos: json("photos").$type<string[]>(),
  // ─── Guest attribution (added with the SMS feature) ───────────────────────
  // guestId is set when staff pick an existing guest from the search picker
  // (FK to guest_registrations.id) OR when the report is raised by the guest
  // themselves from the PWA. guestSurname / guestMobile capture the values
  // either pulled from the guest's record or typed manually by staff. The
  // auto-SMS dispatcher prefers report-attached values over a room-number
  // lookup so cabin/site/location-type rooms still notify correctly.
  guestId: integer("guest_id"),
  guestSurname: text("guest_surname"),
  guestMobile: text("guest_mobile"),
  // Lifecycle: open -> in_progress -> resolved
  status: text("status").notNull().default("open"), // "open" | "in_progress" | "resolved"
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Acknowledged (in_progress)
  inProgressAt: timestamp("in_progress_at"),
  inProgressByStaffId: integer("in_progress_by_staff_id"),
  inProgressByName: text("in_progress_by_name"),
  inProgressNote: text("in_progress_note"), // e.g. "Assigned to HK 2"
  // ETA captured at acknowledge time. Exactly one of etaHours / etaText is
  // populated: etaHours (1, 2, 4, 24, 48) for preset choices; etaText for the
  // "Other" free-text option (e.g. "by tomorrow morning"). Communicated to
  // the guest as an estimate only.
  etaHours: integer("eta_hours"),
  etaText: text("eta_text"),
  // Resolved (sign-off)
  resolution: text("resolution"), // "actioned" | "delegated"
  resolvedByStaffId: integer("resolved_by_staff_id"),
  resolvedByName: text("resolved_by_name"),
  resolutionNote: text("resolution_note"),
  resolvedAt: timestamp("resolved_at"),
  resolutionNoteEditedByName: text("resolution_note_edited_by_name"),
  resolutionNoteEditedAt: timestamp("resolution_note_edited_at"),
  tenantId: integer("tenant_id").notNull().default(1),
});

export const insertHousekeepingReportSchema = createInsertSchema(housekeepingReportsTable).omit({
  id: true,
  createdAt: true,
  resolvedAt: true,
  resolvedByStaffId: true,
  resolvedByName: true,
  resolutionNote: true,
  status: true,
  resolution: true,
  inProgressAt: true,
  inProgressByStaffId: true,
  inProgressByName: true,
  inProgressNote: true,
  openedByStaffId: true,
  openedByName: true,
  source: true,
});

export type InsertHousekeepingReport = z.infer<typeof insertHousekeepingReportSchema>;
export type HousekeepingReport = typeof housekeepingReportsTable.$inferSelect;
