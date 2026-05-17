import { Router } from "express";
import { db } from "@workspace/db";
import { guestRegistrationsTable, insertGuestRegistrationSchema } from "@workspace/db/schema";
import { and, eq, like, sql } from "drizzle-orm";
import { requireStaffAuth, resolveTenant } from "../middlewares/staffAuth";
import type { TenantRequest } from "../middlewares/staffAuth";
import { normalisePhoneNumber } from "../lib/sms";

const guestsRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Shared validation helpers

const VALID_ACCOMMODATION_TYPES = ["room", "cabin", "camping_site"] as const;
type AccommodationType = (typeof VALID_ACCOMMODATION_TYPES)[number];

function isValidAccommodationType(value: unknown): value is AccommodationType {
  return typeof value === "string" && (VALID_ACCOMMODATION_TYPES as readonly string[]).includes(value);
}

/**
 * Camping registrations without an explicit site label get auto-assigned
 * "CAMP-001", "CAMP-002", ... per tenant. Scans existing CAMP-% rows for the
 * tenant and increments the highest 3-digit suffix found. Wrapped in a
 * transaction to avoid race conditions when two campers register at once.
 */
async function allocateCampLabel(tenantId: number): Promise<string> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ roomNumber: guestRegistrationsTable.roomNumber })
      .from(guestRegistrationsTable)
      .where(
        and(
          eq(guestRegistrationsTable.tenantId, tenantId),
          like(guestRegistrationsTable.roomNumber, "CAMP-%"),
        ),
      );
    let highest = 0;
    for (const row of existing) {
      const m = /^CAMP-(\d+)$/i.exec(row.roomNumber);
      if (m && m[1]) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > highest) highest = n;
      }
    }
    const next = highest + 1;
    return `CAMP-${String(next).padStart(3, "0")}`;
  });
}

/**
 * Centralised JSON shape for guest responses — keeps the API client types
 * stable regardless of which endpoint produced the row.
 */
function serialiseGuest(g: typeof guestRegistrationsTable.$inferSelect) {
  return {
    id: g.id,
    name: g.name,
    roomNumber: g.roomNumber,
    accommodationType: g.accommodationType,
    arrivalDate: g.arrivalDate ?? null,
    mobile: g.mobile ?? null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Guest self-register

guestsRouter.post("/guests/register", resolveTenant, async (req, res) => {
  const parsed = insertGuestRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const tenantId = (req as unknown as TenantRequest).tenantId;
  const {
    name: rawName,
    roomNumber: rawRoom,
    pushToken,
    webPushSubscription,
    accommodationType: rawType,
    arrivalDate: rawArrival,
    mobile: rawMobile,
  } = parsed.data as {
    name: string;
    roomNumber: string;
    pushToken: string;
    webPushSubscription?: string | null;
    accommodationType?: string;
    arrivalDate?: string | null;
    mobile?: string | null;
  };

  if (!pushToken || !pushToken.trim()) {
    res.status(400).json({ error: "Invalid push token" });
    return;
  }

  const accommodationType: AccommodationType = isValidAccommodationType(rawType) ? rawType : "room";

  // Mobile is mandatory for self-register so that maintenance/housekeeping
  // auto-SMS can always reach the guest. The normaliser coerces "0412..." into
  // E.164; null result means the input is unusable and we reject.
  const normalisedMobile = normalisePhoneNumber(rawMobile);
  if (!normalisedMobile) {
    res.status(400).json({
      code: "mobile_required",
      error:
        "A valid mobile number is required so reception can send you SMS notifications about your stay.",
    });
    return;
  }

  const name = rawName.trim();

  // Decide the room/site label. Camping → server allocates; everyone else
  // uses the supplied number (uppercased to match existing convention).
  let roomNumber: string;
  if (accommodationType === "camping_site") {
    const supplied = (rawRoom ?? "").trim();
    roomNumber = supplied ? supplied.toUpperCase() : await allocateCampLabel(tenantId);
  } else {
    if (!rawRoom || !rawRoom.trim()) {
      res.status(400).json({ error: "Room/cabin number is required" });
      return;
    }
    roomNumber = rawRoom.trim().toUpperCase();
  }

  const arrivalDate = accommodationType === "camping_site" && rawArrival ? rawArrival : null;

  // Conflict detection differs between fixed accommodation and camping:
  //   Room/cabin: legacy rule — same room with a different surname → 409.
  //   Camping: "same name + same arrival date" → 409 (duplicate). Same name
  //   with different arrival dates is fine (different stays).
  const allMatches = await db
    .select()
    .from(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        accommodationType === "camping_site"
          ? sql`lower(${guestRegistrationsTable.name}) = lower(${name})`
          : eq(guestRegistrationsTable.roomNumber, roomNumber),
      ),
    );

  if (accommodationType === "camping_site") {
    const dup = allMatches.find(
      (r) => r.accommodationType === "camping_site" && r.arrivalDate === arrivalDate,
    );
    if (dup) {
      res.status(409).json({
        code: "duplicate",
        error:
          "You're already registered as a camping guest with that arrival date. Use Returning Guest to reconnect your device.",
      });
      return;
    }
  } else {
    const differentNameRecord = allMatches.find(
      (r) => r.name.toLowerCase() !== name.toLowerCase(),
    );
    if (differentNameRecord) {
      res.status(409).json({
        code: "room_taken",
        error: "That room is already taken. Please double check your booking and try again.",
      });
      return;
    }
    const sameNameRecord = allMatches.find(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    );
    if (sameNameRecord) {
      res.status(409).json({
        code: "duplicate",
        error: "You're already registered for that surname and room. Use Returning Guest to reconnect your device.",
      });
      return;
    }
  }

  const [inserted] = await db
    .insert(guestRegistrationsTable)
    .values({
      name,
      roomNumber,
      accommodationType,
      arrivalDate,
      mobile: normalisedMobile,
      pushToken,
      webPushSubscription,
      tenantId,
    })
    .returning();

  res.status(201).json(serialiseGuest(inserted));
});

// ─────────────────────────────────────────────────────────────────────────────
// Staff register (reception pre-creates a guest record)

guestsRouter.post("/guests/register/staff", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const {
    name: rawName,
    roomNumber: rawRoom,
    accommodationType: rawType,
    arrivalDate: rawArrival,
    mobile: rawMobile,
  } = req.body as {
    name?: unknown;
    roomNumber?: unknown;
    accommodationType?: unknown;
    arrivalDate?: unknown;
    mobile?: unknown;
  };

  if (!rawName || typeof rawName !== "string" || !rawName.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!isValidAccommodationType(rawType)) {
    res.status(400).json({ error: "accommodationType must be 'room', 'cabin' or 'camping_site'" });
    return;
  }

  // Mobile is mandatory when staff register on behalf of a guest — that's the
  // explicit product requirement so SMS notifications can fire.
  const normalisedMobile = normalisePhoneNumber(typeof rawMobile === "string" ? rawMobile : null);
  if (!normalisedMobile) {
    res.status(400).json({
      code: "mobile_required",
      error: "A valid mobile number is required so reception can send the guest SMS notifications.",
    });
    return;
  }

  const accommodationType: AccommodationType = rawType;
  const name = rawName.trim();

  let roomNumber: string;
  if (accommodationType === "camping_site") {
    const supplied = typeof rawRoom === "string" ? rawRoom.trim() : "";
    roomNumber = supplied ? supplied.toUpperCase() : await allocateCampLabel(tenantId);
  } else {
    if (!rawRoom || typeof rawRoom !== "string" || !rawRoom.trim()) {
      res.status(400).json({ error: "roomNumber is required for room/cabin" });
      return;
    }
    roomNumber = rawRoom.trim().toUpperCase();
  }

  const arrivalDate =
    accommodationType === "camping_site" && typeof rawArrival === "string" && rawArrival
      ? rawArrival
      : null;

  // Reject duplicates the same way the self-register endpoint does, so staff
  // can't silently create conflicting rows.
  const allMatches = await db
    .select()
    .from(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        accommodationType === "camping_site"
          ? sql`lower(${guestRegistrationsTable.name}) = lower(${name})`
          : eq(guestRegistrationsTable.roomNumber, roomNumber),
      ),
    );

  if (accommodationType === "camping_site") {
    const dup = allMatches.find(
      (r) => r.accommodationType === "camping_site" && r.arrivalDate === arrivalDate,
    );
    if (dup) {
      res.status(409).json({ code: "duplicate", error: "A camping guest with that name and arrival date already exists." });
      return;
    }
  } else {
    const differentNameRecord = allMatches.find(
      (r) => r.name.toLowerCase() !== name.toLowerCase(),
    );
    if (differentNameRecord) {
      res.status(409).json({ code: "room_taken", error: "That room is already registered to another guest." });
      return;
    }
    const sameNameRecord = allMatches.find(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    );
    if (sameNameRecord) {
      res.status(409).json({ code: "duplicate", error: "That guest is already registered." });
      return;
    }
  }

  // Placeholder push token. The guest's device claims the record later via
  // Returning Guest login, which overwrites this with their real token.
  const placeholderToken = `staff-pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const [inserted] = await db
    .insert(guestRegistrationsTable)
    .values({
      name,
      roomNumber,
      accommodationType,
      arrivalDate,
      mobile: normalisedMobile,
      pushToken: placeholderToken,
      tenantId,
    })
    .returning();

  res.status(201).json(serialiseGuest(inserted));
});

// ─────────────────────────────────────────────────────────────────────────────
// Guest login (returning guest re-links device)

guestsRouter.post("/guests/login", resolveTenant, async (req, res) => {
  const {
    name,
    roomNumber,
    pushToken,
    webPushSubscription,
    accommodationType: rawType,
    arrivalDate: rawArrival,
  } = req.body as {
    name?: unknown;
    roomNumber?: unknown;
    pushToken?: unknown;
    webPushSubscription?: unknown;
    accommodationType?: unknown;
    arrivalDate?: unknown;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const accommodationType: AccommodationType = isValidAccommodationType(rawType) ? rawType : "room";
  const normName = name.trim();
  const normToken = typeof pushToken === "string" && pushToken.trim() ? pushToken.trim() : null;
  const tenantId = (req as unknown as TenantRequest).tenantId;

  // Room / cabin path — unchanged from the legacy behaviour.
  if (accommodationType !== "camping_site") {
    if (!roomNumber || typeof roomNumber !== "string" || !roomNumber.trim()) {
      res.status(400).json({ error: "roomNumber is required" });
      return;
    }
    const normRoom = roomNumber.trim().toUpperCase();

    const allRoomRecords = await db
      .select()
      .from(guestRegistrationsTable)
      .where(
        and(
          eq(guestRegistrationsTable.tenantId, tenantId),
          eq(guestRegistrationsTable.roomNumber, normRoom),
        ),
      );

    const conflictRecord = allRoomRecords.find(
      (r) => r.name.toLowerCase() !== normName.toLowerCase(),
    );
    if (conflictRecord) {
      res.status(409).json({
        code: "room_taken",
        error: "That room is registered to a different guest. Please contact Reception if you believe this is an error.",
      });
      return;
    }

    const existing = allRoomRecords.find(
      (r) => r.name.toLowerCase() === normName.toLowerCase(),
    );
    if (!existing) {
      res.status(404).json({ error: "No guest found with that name and room number. Please register first." });
      return;
    }

    const sub = typeof webPushSubscription === "string" ? webPushSubscription : null;
    const tokenToStore = normToken ?? existing.pushToken;

    const [updated] = await db
      .update(guestRegistrationsTable)
      .set({ pushToken: tokenToStore, webPushSubscription: sub, updatedAt: new Date() })
      .where(
        and(
          eq(guestRegistrationsTable.tenantId, tenantId),
          eq(guestRegistrationsTable.id, existing.id),
        ),
      )
      .returning();

    res.json(serialiseGuest(updated));
    return;
  }

  // Camping path — disambiguate by arrival date when there are multiple matches.
  const matches = await db
    .select()
    .from(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.accommodationType, "camping_site"),
        sql`lower(${guestRegistrationsTable.name}) = lower(${normName})`,
      ),
    );

  if (matches.length === 0) {
    res.status(404).json({ error: "No camping guest found with that name. Please register first." });
    return;
  }

  let target = matches[0];
  if (matches.length > 1) {
    const arrival = typeof rawArrival === "string" && rawArrival ? rawArrival : null;
    if (!arrival) {
      res.status(409).json({
        code: "needs_arrival_date",
        error:
          "More than one camping guest with that surname was found. Please provide your arrival date to continue.",
      });
      return;
    }
    const candidate = matches.find((m) => m.arrivalDate === arrival);
    if (!candidate) {
      res.status(404).json({
        code: "no_match_for_arrival_date",
        error: "No camping registration matches that surname and arrival date.",
      });
      return;
    }
    target = candidate;
  }

  const sub = typeof webPushSubscription === "string" ? webPushSubscription : null;
  const tokenToStore = normToken ?? target.pushToken;

  const [updated] = await db
    .update(guestRegistrationsTable)
    .set({ pushToken: tokenToStore, webPushSubscription: sub, updatedAt: new Date() })
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.id, target.id),
      ),
    )
    .returning();

  res.json(serialiseGuest(updated));
});

// ─────────────────────────────────────────────────────────────────────────────
// Update guest (self-service, authenticated by pushToken)

guestsRouter.put("/guests/:id", resolveTenant, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid guest ID" });
    return;
  }

  const { pushToken, name, roomNumber, accommodationType, arrivalDate, mobile } = req.body as {
    pushToken?: unknown;
    name?: unknown;
    roomNumber?: unknown;
    accommodationType?: unknown;
    arrivalDate?: unknown;
    mobile?: unknown;
  };

  if (!pushToken || typeof pushToken !== "string" || !pushToken.trim()) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  if (!roomNumber || typeof roomNumber !== "string" || !roomNumber.trim()) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const tenantId = (req as unknown as TenantRequest).tenantId;

  const existing = await db
    .select()
    .from(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.id, id),
      ),
    );

  if (existing.length === 0) {
    res.status(404).json({ error: "Guest not found" });
    return;
  }

  if (existing[0].pushToken !== pushToken) {
    res.status(403).json({ error: "Forbidden: push token does not match" });
    return;
  }

  const newType: AccommodationType = isValidAccommodationType(accommodationType)
    ? accommodationType
    : existing[0].accommodationType as AccommodationType;

  // Optional mobile update — if supplied, must validate.
  let mobileUpdate: { mobile: string } | undefined;
  if (mobile !== undefined && mobile !== null) {
    const norm = normalisePhoneNumber(typeof mobile === "string" ? mobile : null);
    if (!norm) {
      res.status(400).json({ code: "mobile_required", error: "A valid mobile number is required." });
      return;
    }
    mobileUpdate = { mobile: norm };
  }

  const newArrival =
    newType === "camping_site" && typeof arrivalDate === "string" && arrivalDate ? arrivalDate : null;

  const [updated] = await db
    .update(guestRegistrationsTable)
    .set({
      name: (name as string).trim(),
      roomNumber: (roomNumber as string).trim().toUpperCase(),
      accommodationType: newType,
      arrivalDate: newArrival,
      ...(mobileUpdate ?? {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.id, id),
      ),
    )
    .returning();

  res.json(serialiseGuest(updated));
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete guest (self-service, authenticated by pushToken)

guestsRouter.delete("/guests/:id", resolveTenant, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid guest ID" });
    return;
  }

  const { pushToken } = req.body as { pushToken?: unknown };
  if (!pushToken || typeof pushToken !== "string" || !pushToken.trim()) {
    res.status(400).json({ error: "pushToken is required" });
    return;
  }

  const tenantId = (req as unknown as TenantRequest).tenantId;

  const existing = await db
    .select()
    .from(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.id, id),
      ),
    );

  if (existing.length === 0) {
    res.status(404).json({ error: "Guest not found" });
    return;
  }

  if (existing[0].pushToken !== pushToken) {
    res.status(403).json({ error: "Forbidden: push token does not match" });
    return;
  }

  await db
    .delete(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.id, id),
      ),
    );

  res.status(204).send();
});

// ─────────────────────────────────────────────────────────────────────────────
// Staff: remove a guest (no push token required)

guestsRouter.delete("/guests/:id/staff", requireStaffAuth, async (req, res) => {
  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid guest ID" });
    return;
  }

  const tenantId = (req as unknown as TenantRequest).tenantId;

  const existing = await db
    .select()
    .from(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.id, id),
      ),
    );

  if (existing.length === 0) {
    res.status(404).json({ error: "Guest not found" });
    return;
  }

  await db
    .delete(guestRegistrationsTable)
    .where(
      and(
        eq(guestRegistrationsTable.tenantId, tenantId),
        eq(guestRegistrationsTable.id, id),
      ),
    );

  res.status(204).send();
});

// ─────────────────────────────────────────────────────────────────────────────
// Staff: list all guests for this tenant

guestsRouter.get("/guests", requireStaffAuth, async (req, res) => {
  const tenantId = (req as unknown as TenantRequest).tenantId;
  const { roomNumber } = req.query;

  const conditions = [eq(guestRegistrationsTable.tenantId, tenantId)];
  if (roomNumber && typeof roomNumber === "string") {
    conditions.push(eq(guestRegistrationsTable.roomNumber, roomNumber));
  }

  const guests = await db
    .select()
    .from(guestRegistrationsTable)
    .where(and(...conditions));

  res.json(guests.map(serialiseGuest));
});

export default guestsRouter;
