import { pgTable, serial, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  sessionsRevokedBefore: timestamp("sessions_revoked_before"),
  // ─── SMS settings ────────────────────────────────────────────────────────
  // Toggle whether the server fires a templated SMS on acknowledge / resolve.
  // Defaults to true per product requirement; reception can flip from the
  // admin SMS Settings page if SMS spend needs to be cut.
  smsAutoSendOnAcknowledge: boolean("sms_auto_send_on_acknowledge").notNull().default(true),
  smsAutoSendOnResolve: boolean("sms_auto_send_on_resolve").notNull().default(true),
  // Appended to every outbound SMS (manual + auto). Stored once so it can be
  // edited without a code change. Default mirrors the wording approved in plan.
  smsFooter: text("sms_footer").notNull().default(
    "(Please note this number cannot receive SMS or calls — contact Reception for further details.)\n— Krishna Village",
  ),
});

export type Tenant = typeof tenantsTable.$inferSelect;
