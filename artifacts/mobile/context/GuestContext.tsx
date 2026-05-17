import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useContext, useEffect, useState } from "react";

export interface GuestProfile {
  id?: number;
  name: string;
  roomNumber: string;
  pushToken: string;
  registeredAt: string;
  // ── New fields (added with the SMS / accommodation-type feature) ─────────
  accommodationType?: "room" | "cabin" | "camping_site";
  arrivalDate?: string | null;
  mobile?: string | null;
}

interface GuestContextValue {
  guest: GuestProfile | null;
  isLoading: boolean;
  setGuest: (guest: GuestProfile | null) => void;
  clearGuest: () => void;
}

const GUEST_STORAGE_KEY = "@krishna_village_guest";

const GuestContext = createContext<GuestContextValue>({
  guest: null,
  isLoading: true,
  setGuest: () => {},
  clearGuest: () => {},
});

async function resolveGuestId(profile: GuestProfile): Promise<GuestProfile> {
  if (profile.id) return profile;
  try {
    const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
      ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
      : "";
    const resp = await fetch(`${baseUrl}/api/guests/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: profile.name,
        roomNumber: profile.roomNumber,
        pushToken: profile.pushToken,
      }),
    });
    if (resp.ok) {
      const data = await resp.json() as { id?: number };
      if (data.id) return { ...profile, id: data.id };
    }
  } catch {}
  return profile;
}

export function GuestProvider({ children }: { children: React.ReactNode }) {
  const [guest, setGuestState] = useState<GuestProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(GUEST_STORAGE_KEY)
      .then(async (val) => {
        if (val) {
          const stored: GuestProfile = JSON.parse(val);
          if (!stored.id) {
            const resolved = await resolveGuestId(stored);
            if (resolved.id) {
              AsyncStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(resolved)).catch(() => {});
            }
            setGuestState(resolved);
          } else {
            setGuestState(stored);
          }
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const setGuest = (g: GuestProfile | null) => {
    setGuestState(g);
    if (g) {
      AsyncStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(g)).catch(() => {});
    } else {
      AsyncStorage.removeItem(GUEST_STORAGE_KEY).catch(() => {});
    }
  };

  const clearGuest = () => setGuest(null);

  return (
    <GuestContext.Provider value={{ guest, isLoading, setGuest, clearGuest }}>
      {children}
    </GuestContext.Provider>
  );
}

export function useGuest() {
  return useContext(GuestContext);
}
