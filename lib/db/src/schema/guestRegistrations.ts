import { pgTable, text, serial, timestamp, integer, date } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const guestRegistrationsTable = pgTable("guest_registrations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  roomNumber: text("room_number").notNull(),
  // "room" | "cabin" | "camping_site" — defaults to "room" so existing rows backfill cleanly.
  accommodationType: text("accommodation_type").notNull().default("room"),
  // Camping-site arrival date — used to disambiguate returning-guest login when
  // multiple campers share a surname. Null for room/cabin guests.
  arrivalDate: date("arrival_date"),
  // E.164-format mobile number (e.g. +61412345678). Mandatory at the API layer
  // for new registrations; nullable in the DB so legacy rows survive the
  // backfill until reception updates them.
  mobile: text("mobile"),
  pushToken: text("push_token").notNull(),
  webPushSubscription: text("web_push_subscription"),
  tenantId: integer("tenant_id").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGuestRegistrationSchema = createInsertSchema(guestRegistrationsTable).omit({ id: true, createdAt: true });
export type InsertGuestRegistration = z.infer<typeof insertGuestRegistrationSchema>;
export type GuestRegistration = typeof guestRegistrationsTable.$inferSelect;
