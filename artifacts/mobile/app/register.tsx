import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useGuest } from "@/context/GuestContext";
import { setBaseUrl } from "@workspace/api-client-react";

if (process.env.EXPO_PUBLIC_DOMAIN) {
  setBaseUrl(`https://${process.env.EXPO_PUBLIC_DOMAIN}`);
}

const TENANT_ID = process.env.EXPO_PUBLIC_TENANT_ID ?? "1";

try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
} catch {
  // expo-notifications remote push not available in Expo Go SDK 53+
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function getOrCreateDeviceId(): string {
  const STORAGE_KEY = "@krishna_village_device_id";
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    const fresh = `device-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    localStorage.setItem(STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return `device-mem-${Math.random().toString(36).slice(2, 10)}`;
  }
}

type Mode = "register" | "login";

function Icon({ name, size, color, style }: { name: string; size: number; color: string; style?: object }) {
  if (Platform.OS === "web") {
    const map: Record<string, string> = {
      "x": "✕",
      "user-plus": "＋",
      "log-in": "→",
      "user": "👤",
      "home": "🏠",
      "alert-circle": "⚠",
      "check-circle": "✓",
    };
    return (
      <Text style={[{ fontSize: size * 0.85, color, lineHeight: size * 1.1 }, style]}>
        {map[name] ?? "•"}
      </Text>
    );
  }
  return <Feather name={name as never} size={size} color={color} style={style} />;
}

/**
 * Client-side mobile-number coercion. Mirrors the server normaliser so we
 * surface clear inline feedback before submitting. Returns null on invalid.
 */
function normaliseMobile(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!cleaned) return null;
  if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;
  if (/^0\d{9}$/.test(cleaned)) return `+61${cleaned.slice(1)}`;
  if (/^61\d{9}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

export default function RegisterScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { setGuest } = useGuest();

  const [mode, setMode] = useState<Mode>("register");
  const [name, setName] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [isRoomTaken, setIsRoomTaken] = useState(false);
  // ─── New fields (accommodation type / mobile / arrival date) ───────────────
  // Three accommodation types share the room input; camping_site relaxes the
  // requirement and auto-assigns CAMP-NNN server-side if the field is empty.
  const [accommodationType, setAccommodationType] = useState<"room" | "cabin" | "camping_site">("room");
  const [mobile, setMobile] = useState("");
  const [arrivalDate, setArrivalDate] = useState(""); // YYYY-MM-DD for camping
  // Camping-disambiguation flow: when /login returns 409 needs_arrival_date,
  // we show a modal asking for the arrival date and replay the request with it.
  const [needsArrivalDate, setNeedsArrivalDate] = useState(false);
  const [arrivalDatePromptValue, setArrivalDatePromptValue] = useState("");

  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  async function getPushCredentials(): Promise<{ token: string; webPushSubscription?: string }> {
    if (Platform.OS !== "web") {
      try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;
        if (existingStatus !== "granted") {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }
        if (finalStatus === "granted") {
          const tokenData = await Notifications.getExpoPushTokenAsync();
          return { token: tokenData.data };
        }
      } catch {}
      return { token: getOrCreateDeviceId() };
    }

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return { token: getOrCreateDeviceId() };
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return { token: getOrCreateDeviceId() };

      const vapidResp = await fetch(`${baseUrl}/api/vapid-public-key`, {
        headers: { "X-Tenant-ID": TENANT_ID },
      });
      if (!vapidResp.ok) throw new Error("No VAPID key");
      const { publicKey } = await vapidResp.json() as { publicKey: string };

      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;

      const existing = await reg.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
      });

      const subJson = JSON.stringify(subscription);
      const shortId = subscription.endpoint.slice(-12).replace(/[^a-zA-Z0-9]/g, "");
      return { token: `web-${shortId}`, webPushSubscription: subJson };
    } catch {
      return { token: getOrCreateDeviceId() };
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setIsDuplicate(false);
    setIsRoomTaken(false);
  }

  function switchToReturning() {
    setMode("login");
    setError(null);
    setIsDuplicate(false);
    setIsRoomTaken(false);
  }

  /**
   * Submit handler — used by both register and login flows. Accepts an optional
   * arrivalDateOverride so the camping-disambiguation modal can replay the
   * request with the date the guest just entered.
   */
  async function handleSubmit(arrivalDateOverride?: string) {
    if (!name.trim()) { setError("Please enter your surname"); return; }
    // Room/cabin require a number; camping_site does not (server auto-assigns).
    if (accommodationType !== "camping_site" && !roomNumber.trim()) {
      setError(`Please enter your ${accommodationType === "cabin" ? "cabin" : "room"} number`);
      return;
    }

    // Mobile is mandatory at registration. On returning-guest login we let it
    // through empty because the existing record already has one on file.
    let normalisedMobile: string | null = null;
    if (mode === "register") {
      if (!mobile.trim()) {
        setError("Please enter your mobile number — used for SMS notifications.");
        return;
      }
      normalisedMobile = normaliseMobile(mobile.trim());
      if (!normalisedMobile) {
        setError("That mobile number doesn't look right. Please enter it like 0412 345 678.");
        return;
      }
    }

    setError(null);
    setIsDuplicate(false);
    setIsRoomTaken(false);
    setIsLoading(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    try {
      const { token: pushToken, webPushSubscription } = await getPushCredentials();
      const room = roomNumber.trim().toUpperCase();
      const effectiveArrival =
        arrivalDateOverride ?? (accommodationType === "camping_site" ? arrivalDate : "");

      const endpoint = mode === "register" ? "/api/guests/register" : "/api/guests/login";
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tenant-ID": TENANT_ID },
        body: JSON.stringify({
          name: name.trim(),
          roomNumber: room,
          pushToken,
          accommodationType,
          ...(effectiveArrival ? { arrivalDate: effectiveArrival } : {}),
          ...(normalisedMobile ? { mobile: normalisedMobile } : {}),
          ...(webPushSubscription ? { webPushSubscription } : {}),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (response.status === 409 && data.code === "duplicate") {
          setIsDuplicate(true);
        } else if (response.status === 409 && data.code === "room_taken") {
          setIsRoomTaken(true);
        } else if (response.status === 409 && data.code === "needs_arrival_date") {
          // Two camping guests share this surname — ask the guest which stay.
          setNeedsArrivalDate(true);
        } else if (response.status === 404) {
          setError("No registration found for that surname and room. Please register as a new guest.");
        } else if (response.status === 400 && data.code === "mobile_required") {
          setError(data.error ?? "A valid mobile number is required.");
        } else {
          setError(data.error ?? (mode === "register" ? "Registration failed. Please try again." : "Login failed. Please try again."));
        }
        setIsLoading(false);
        return;
      }

      const data = await response.json() as { id?: number; roomNumber?: string };
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      setGuest({
        id: data.id,
        name: name.trim(),
        // Use the server's roomNumber (handles auto-assigned CAMP-NNN for camping).
        roomNumber: data.roomNumber ?? room,
        pushToken,
        registeredAt: new Date().toISOString(),
      });

      router.replace("/(tabs)/notifications");
    } catch {
      setError("Could not connect. Please check your connection.");
      setIsLoading(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {/* Close / skip button */}
      <Pressable
        onPress={() => router.replace("/(tabs)/notifications")}
        style={[styles.closeButton, { top: insets.top + 12, backgroundColor: colors.muted, borderColor: colors.border }]}
        accessibilityLabel="Close registration"
      >
        <Icon name="x" size={18} color={colors.mutedForeground} />
      </Pressable>

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + (Platform.OS === "web" ? 67 : 20), paddingBottom: insets.bottom + 40 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Image
            source={require("@/assets/images/icon.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.brand}>Krishna Village</Text>
          <Text style={styles.subBrand}>Eco Yoga Community</Text>
          <Text style={[styles.tagline, { color: colors.mutedForeground }]}>
            525 Tyalgum Rd, Eungella NSW
          </Text>
        </View>

        {/* Mode toggle */}
        <View style={[styles.modeToggle, { backgroundColor: colors.muted, borderColor: colors.border }]}>
          <Pressable
            onPress={() => switchMode("register")}
            style={[
              styles.modeBtn,
              mode === "register" && { backgroundColor: colors.card, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
            ]}
          >
            <Icon
              name="user-plus"
              size={15}
              color={mode === "register" ? colors.primary : colors.mutedForeground}
            />
            <Text style={[styles.modeBtnText, { color: mode === "register" ? colors.primary : colors.mutedForeground }]}>
              New Guest
            </Text>
          </Pressable>
          <Pressable
            onPress={() => switchMode("login")}
            style={[
              styles.modeBtn,
              mode === "login" && { backgroundColor: colors.card, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
            ]}
          >
            <Icon
              name="log-in"
              size={15}
              color={mode === "login" ? colors.primary : colors.mutedForeground}
            />
            <Text style={[styles.modeBtnText, { color: mode === "login" ? colors.primary : colors.mutedForeground }]}>
              Returning Guest
            </Text>
          </Pressable>
        </View>

        {/* Card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {mode === "register" ? (
            <>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Welcome, dear Guest</Text>
              <Text style={[styles.cardBody, { color: colors.mutedForeground }]}>
                Register to receive notifications about your stay — room updates, activities, and more.
              </Text>
            </>
          ) : (
            <>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Welcome back</Text>
              <Text style={[styles.cardBody, { color: colors.mutedForeground }]}>
                Enter the surname and room number you registered with to restore your profile on this device.
              </Text>
            </>
          )}

          <View style={styles.fields}>
            {/* Accommodation Type — three pill buttons. Camping relaxes the
                room-number requirement and lets the server auto-assign CAMP-NNN. */}
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>Type of accommodation</Text>
              <View style={[styles.typePickerRow, { borderColor: colors.border, backgroundColor: colors.muted }]}>
                {(["room", "cabin", "camping_site"] as const).map((t) => {
                  const active = accommodationType === t;
                  const label = t === "room" ? "Room" : t === "cabin" ? "Cabin" : "Camping";
                  const iconName = t === "room" ? "home" : t === "cabin" ? "home" : "alert-circle";
                  return (
                    <Pressable
                      key={t}
                      onPress={() => setAccommodationType(t)}
                      style={[
                        styles.typePickerBtn,
                        active && { backgroundColor: colors.card, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4, elevation: 2 },
                      ]}
                    >
                      <Icon name={iconName} size={14} color={active ? colors.primary : colors.mutedForeground} />
                      <Text style={[styles.typePickerBtnText, { color: active ? colors.primary : colors.mutedForeground }]}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Name */}
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>Surname</Text>
              <View style={[styles.inputWrapper, { borderColor: colors.input, backgroundColor: colors.muted }]}>
                <Icon name="user" size={18} color={colors.mutedForeground} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder={mode === "register" ? "e.g. Sharma" : "Surname you registered with"}
                  placeholderTextColor={colors.mutedForeground}
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  autoComplete="family-name"
                  returnKeyType="next"
                />
              </View>
            </View>

            {/* Room / Cabin / Site number — required for room+cabin, optional for camping. */}
            <View style={styles.fieldGroup}>
              <Text style={[styles.label, { color: colors.foreground }]}>
                {accommodationType === "camping_site"
                  ? "Site number (optional)"
                  : accommodationType === "cabin"
                  ? "Cabin Number"
                  : "Room Number"}
              </Text>
              <View style={[styles.inputWrapper, { borderColor: colors.input, backgroundColor: colors.muted }]}>
                <Icon name="home" size={18} color={colors.mutedForeground} style={styles.inputIcon} />
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder={accommodationType === "camping_site" ? "Leave blank for auto CAMP-NNN" : "e.g. 12"}
                  placeholderTextColor={colors.mutedForeground}
                  value={roomNumber}
                  onChangeText={setRoomNumber}
                  autoCapitalize="characters"
                  keyboardType="default"
                  returnKeyType="next"
                />
              </View>
            </View>

            {/* Arrival date — camping only. Used to disambiguate returning-guest
                login when multiple campers share a surname. */}
            {accommodationType === "camping_site" && (
              <View style={styles.fieldGroup}>
                <Text style={[styles.label, { color: colors.foreground }]}>Arrival date</Text>
                <View style={[styles.inputWrapper, { borderColor: colors.input, backgroundColor: colors.muted }]}>
                  <Icon name="alert-circle" size={18} color={colors.mutedForeground} style={styles.inputIcon} />
                  <TextInput
                    style={[styles.input, { color: colors.foreground }]}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.mutedForeground}
                    value={arrivalDate}
                    onChangeText={setArrivalDate}
                    keyboardType={Platform.OS === "web" ? "default" : "numbers-and-punctuation"}
                    returnKeyType="next"
                  />
                </View>
              </View>
            )}

            {/* Mobile — required for new registrations so SMS notifications can fire. */}
            {mode === "register" && (
              <View style={styles.fieldGroup}>
                <Text style={[styles.label, { color: colors.foreground }]}>Mobile number</Text>
                <View style={[styles.inputWrapper, { borderColor: colors.input, backgroundColor: colors.muted }]}>
                  <Icon name="user" size={18} color={colors.mutedForeground} style={styles.inputIcon} />
                  <TextInput
                    style={[styles.input, { color: colors.foreground }]}
                    placeholder="0412 345 678"
                    placeholderTextColor={colors.mutedForeground}
                    value={mobile}
                    onChangeText={setMobile}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    returnKeyType="done"
                    onSubmitEditing={() => handleSubmit()}
                  />
                </View>
                <Text style={[styles.helpText, { color: colors.mutedForeground }]}>
                  Required — Krishna Village will send you SMS updates about maintenance,
                  housekeeping and reception. (Outbound only — replies aren't received.)
                </Text>
              </View>
            )}
          </View>

          {isDuplicate && (
            <View style={[styles.duplicateBanner, { backgroundColor: colors.primary + "12", borderColor: colors.primary + "40" }]}>
              <Icon name="alert-circle" size={14} color={colors.primary} />
              <View style={styles.duplicateContent}>
                <Text style={[styles.duplicateText, { color: colors.foreground }]}>
                  You're already registered for that surname and room.
                </Text>
                <Pressable
                  onPress={switchToReturning}
                  style={[styles.duplicateBtn, { backgroundColor: colors.primary }]}
                >
                  <Icon name="log-in" size={14} color={colors.primaryForeground} />
                  <Text style={[styles.duplicateBtnText, { color: colors.primaryForeground }]}>
                    Switch to Returning Guest
                  </Text>
                </Pressable>
              </View>
            </View>
          )}

          {error && (
            <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "30" }]}>
              <Icon name="alert-circle" size={14} color={colors.destructive} />
              <Text style={[styles.errorText, { color: colors.destructive }]}>{error}</Text>
            </View>
          )}

          <Pressable
            onPress={handleSubmit}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.submitBtn,
              { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            {isLoading ? (
              <ActivityIndicator color={colors.primaryForeground} size="small" />
            ) : (
              <>
                <Icon
                  name={mode === "register" ? "check-circle" : "log-in"}
                  size={18}
                  color={colors.primaryForeground}
                />
                <Text style={[styles.submitBtnText, { color: colors.primaryForeground }]}>
                  {mode === "register" ? "Register" : "Sign In"}
                </Text>
              </>
            )}
          </Pressable>
        </View>

        {/* Switch mode hint */}
        <View style={styles.switchHint}>
          {mode === "register" ? (
            <Text style={[styles.switchHintText, { color: colors.mutedForeground }]}>
              Stayed with us before?{" "}
              <Text
                style={[styles.switchHintLink, { color: colors.primary }]}
                onPress={() => switchMode("login")}
              >
                Sign in instead
              </Text>
            </Text>
          ) : (
            <Text style={[styles.switchHintText, { color: colors.mutedForeground }]}>
              First time here?{" "}
              <Text
                style={[styles.switchHintLink, { color: colors.primary }]}
                onPress={() => switchMode("register")}
              >
                Register as a new guest
              </Text>
            </Text>
          )}
        </View>
      </ScrollView>

      {/* ── Camping disambiguation modal ── */}
      <Modal
        visible={needsArrivalDate}
        animationType="fade"
        transparent
        onRequestClose={() => setNeedsArrivalDate(false)}
      >
        <View style={styles.roomTakenOverlay}>
          <View style={[styles.roomTakenCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.roomTakenIconWrap, { backgroundColor: colors.primary + "15" }]}>
              <Feather name="calendar" size={28} color={colors.primary} />
            </View>
            <Text style={[styles.roomTakenTitle, { color: colors.foreground }]}>
              One more thing…
            </Text>
            <Text style={[styles.roomTakenBody, { color: colors.mutedForeground }]}>
              More than one camping guest with that surname was found. Please confirm
              your arrival date to sign in.
            </Text>
            <View style={[styles.inputWrapper, { borderColor: colors.input, backgroundColor: colors.muted, marginTop: 12, marginBottom: 12 }]}>
              <TextInput
                style={[styles.input, { color: colors.foreground }]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.mutedForeground}
                value={arrivalDatePromptValue}
                onChangeText={setArrivalDatePromptValue}
                autoFocus
              />
            </View>
            <Pressable
              onPress={() => {
                if (!arrivalDatePromptValue.trim()) return;
                const v = arrivalDatePromptValue.trim();
                setNeedsArrivalDate(false);
                setArrivalDatePromptValue("");
                // Retry login with the supplied arrival date.
                handleSubmit(v);
              }}
              style={({ pressed }) => [
                styles.roomTakenBtn,
                { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.roomTakenBtnText, { color: colors.primaryForeground }]}>Continue</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ── Room-Taken Blocking Modal ── */}
      <Modal
        visible={isRoomTaken}
        animationType="fade"
        transparent
        onRequestClose={() => {
          setIsRoomTaken(false);
          setRoomNumber("");
        }}
      >
        <View style={styles.roomTakenOverlay}>
          <View style={[styles.roomTakenCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.roomTakenIconWrap, { backgroundColor: colors.destructive + "15" }]}>
              <Feather name="alert-octagon" size={28} color={colors.destructive} />
            </View>
            <Text style={[styles.roomTakenTitle, { color: colors.foreground }]}>
              Room Already Registered
            </Text>
            <Text style={[styles.roomTakenBody, { color: colors.mutedForeground }]}>
              Room {roomNumber.trim().toUpperCase() || "number"} is already registered with a guest. Please confirm your room number with Reception.
            </Text>
            <Pressable
              onPress={() => {
                setIsRoomTaken(false);
                setRoomNumber("");
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              }}
              style={({ pressed }) => [
                styles.roomTakenBtn,
                { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.roomTakenBtnText, { color: colors.primaryForeground }]}>OK</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  typePickerRow: {
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  typePickerBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: 8,
  },
  typePickerBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  helpText: {
    fontSize: 11,
    marginTop: 6,
    lineHeight: 15,
  },
  container: { flex: 1 },
  closeButton: {
    position: "absolute",
    right: 16,
    zIndex: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    alignItems: "center",
    gap: 20,
  },
  hero: {
    alignItems: "center",
    gap: 8,
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 20,
    marginBottom: 4,
  },
  brand: {
    fontSize: 32,
    fontFamily: "PlayfairDisplay_400Regular",
    letterSpacing: 0.5,
    color: '#1a5276',
  },
  subBrand: {
    fontSize: 15,
    fontFamily: "CormorantSC_300Light",
    letterSpacing: 0.12 * 15,
    marginTop: -4,
    color: '#2e86c1',
  },
  tagline: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  modeToggle: {
    flexDirection: "row",
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    padding: 4,
    gap: 4,
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  modeBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  card: {
    width: "100%",
    borderRadius: 20,
    borderWidth: 1,
    padding: 24,
    gap: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  cardTitle: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.3,
  },
  cardBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  fields: {
    gap: 14,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 48,
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  duplicateBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  duplicateContent: {
    flex: 1,
    gap: 10,
  },
  duplicateText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  duplicateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignSelf: "stretch",
  },
  duplicateBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: 52,
    borderRadius: 14,
    marginTop: 4,
  },
  submitBtnText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
  },
  switchHint: {
    paddingBottom: 8,
  },
  switchHintText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  switchHintLink: {
    fontFamily: "Inter_600SemiBold",
  },
  roomTakenOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  roomTakenCard: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: 1,
    padding: 28,
    alignItems: "center",
    gap: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  roomTakenIconWrap: {
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  roomTakenTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  roomTakenBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
  },
  roomTakenBtn: {
    width: "100%",
    height: 48,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  roomTakenBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
});
