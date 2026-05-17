import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const smsMessagesTable = pgTable("sms_messages", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().default(1),
  // Linked guest, when known. Nullable so broadcasts to arbitrary numbers also fit.
  guestId: integer("guest_id"),
  to: text("to").notNull(), // E.164 destination (+61...)
  body: text("body").notNull(), // final body sent (includes appended footer)
  // Who triggered the send. Null = system / auto-send (acknowledge/resolve).
  sentByStaffId: integer("sent_by_staff_id"),
  sentByName: text("sent_by_name"),
  provider: text("provider").notNull().default("twilio"),
  providerMessageId: text("provider_message_id"),
  // queued | sent | delivered | failed | undelivered | skipped_no_mobile
  status: text("status").notNull().default("queued"),
  errorMessage: text("error_message"),
  linkedMaintenanceReportId: integer("linked_maintenance_report_id"),
  linkedHousekeepingReportId: integer("linked_housekeeping_report_id"),
  // "manual" | "auto_acknowledge" | "auto_resolve" | "broadcast"
  trigger: text("trigger").notNull().default("manual"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  deliveredAt: timestamp("delivered_at"),
});

export const insertSmsMessageSchema = createInsertSchema(smsMessagesTable).omit({
  id: true,
  createdAt: true,
  deliveredAt: true,
});
export type InsertSmsMessage = z.infer<typeof insertSmsMessageSchema>;
export type SmsMessage = typeof smsMessagesTable.$inferSelect;
