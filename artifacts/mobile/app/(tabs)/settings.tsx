import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  TextInput,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useColors } from "@/hooks/useColors";
import { useGuest } from "@/context/GuestContext";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

const PREFS_KEY = "@krishna_village_prefs";

interface NotificationPrefs {
  roomReady: boolean;
  activity: boolean;
  checkoutReminder: boolean;
  general: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = {
  roomReady: true,
  activity: true,
  checkoutReminder: true,
  general: true,
};

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { guest, setGuest, clearGuest } = useGuest();
  const [prefs, setPrefs] = useState<NotificationPrefs>(DEFAULT_PREFS);
  const [notifStatus, setNotifStatus] = useState<string>("unknown");
  const [showFarewell, setShowFarewell] = useState(false);
  const [farewellType, setFarewellType] = useState<"signout" | "clear">("signout");
  const farewellOpacity = useRef(new Animated.Value(0)).current;
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearingProfile, setIsClearingProfile] = useState(false);
  // ── Edit-profile modal state ──────────────────────────────────────────────
  // Lets returning guests update mobile / type / arrival date. Mobile is the
  // highest-value field — legacy records may have no number on file.
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [editMobile, setEditMobile] = useState("");
  const [editType, setEditType] = useState<"room" | "cabin" | "camping_site">("room");
  const [editArrival, setEditArrival] = useState("");
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(PREFS_KEY)
      .then((val) => {
        if (val) setPrefs({ ...DEFAULT_PREFS, ...JSON.parse(val) });
      })
      .catch(() => {});

    if (Platform.OS !== "web") {
      Notifications.getPermissionsAsync()
        .then(({ status }) => { setNotifStatus(status); })
        .catch(() => { setNotifStatus("unavailable"); });
    } else {
      setNotifStatus("granted");
    }
  }, []);

  // Client-side mobile normaliser — mirrors the server's coercion.
  function normaliseMobileSettings(raw: string): string | null {
    const cleaned = raw.replace(/[\s\-().]/g, "");
    if (!cleaned) return null;
    if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;
    if (/^0\d{9}$/.test(cleaned)) return `+61${cleaned.slice(1)}`;
    if (/^61\d{9}$/.test(cleaned)) return `+${cleaned}`;
    return null;
  }

  function openEditProfile() {
    if (!guest) return;
    setEditMobile(guest.mobile ?? "");
    setEditType(guest.accommodationType ?? "room");
    setEditArrival(guest.arrivalDate ?? "");
    setEditError(null);
    setEditProfileOpen(true);
  }

  async function saveProfile() {
    if (!guest?.id || !guest.pushToken) return;
    setEditError(null);
    const norm = normaliseMobileSettings(editMobile.trim());
    if (editMobile.trim() && !norm) {
      setEditError("That mobile number doesn't look right. Try 0412 345 678.");
      return;
    }
    setIsSavingProfile(true);
    try {
      const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
        ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
        : "";
      const resp = await fetchWithTenant(`${baseUrl}/api/guests/${guest.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pushToken: guest.pushToken,
          name: guest.name,
          roomNumber: guest.roomNumber,
          accommodationType: editType,
          ...(editType === "camping_site" && editArrival ? { arrivalDate: editArrival } : {}),
          ...(norm ? { mobile: norm } : {}),
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({})) as { error?: string };
        setEditError(data.error ?? "Could not save your profile. Please try again.");
        setIsSavingProfile(false);
        return;
      }
      const updated = await resp.json() as { mobile?: string | null; accommodationType?: "room" | "cabin" | "camping_site"; arrivalDate?: string | null };
      setGuest({
        ...guest,
        mobile: updated.mobile ?? null,
        accommodationType: updated.accommodationType ?? editType,
        arrivalDate: updated.arrivalDate ?? null,
      });
      setEditProfileOpen(false);
    } catch {
      setEditError("Could not connect. Please check your connection.");
    } finally {
      setIsSavingProfile(false);
    }
  }

    async function togglePref(key: keyof NotificationPrefs) {
    const updated = { ...prefs, [key]: !prefs[key] };
    setPrefs(updated);
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(updated));
    Haptics.selectionAsync();
  }

  async function requestPermissions() {
    if (Platform.OS === "web") return;
    const { status } = await Notifications.requestPermissionsAsync();
    setNotifStatus(status);
    if (status === "granted") {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }

  function handleSignOut() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    clearGuest();
    setFarewellType("signout");
    setShowFarewell(true);
    farewellOpacity.setValue(0);
    Animated.timing(farewellOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
    setTimeout(() => {
      router.replace("/register");
    }, 1500);
  }

  function handleClearProfile() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setShowClearConfirm(true);
  }

  async function handleConfirmClear() {
    setIsClearingProfile(true);
    if (guest?.id && guest.pushToken) {
      try {
        const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
          ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
          : "";
        const resp = await fetchWithTenant(`${baseUrl}/api/guests/${guest.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pushToken: guest.pushToken }),
        });
        if (!resp.ok && resp.status !== 404) {
          setIsClearingProfile(false);
          setShowClearConfirm(false);
          return;
        }
      } catch {
        setIsClearingProfile(false);
        setShowClearConfirm(false);
        return;
      }
    }
    setIsClearingProfile(false);
    setShowClearConfirm(false);
    await AsyncStorage.removeItem(PREFS_KEY).catch(() => {});
    clearGuest();
    setFarewellType("clear");
    setShowFarewell(true);
    farewellOpacity.setValue(0);
    Animated.timing(farewellOpacity, {
      toValue: 1,
      duration: 300,
      useNativeDriver: true,
    }).start();
    setTimeout(() => {
      router.replace("/register");
    }, 1800);
  }

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const bottomPad = insets.bottom + (Platform.OS === "web" ? 34 : 0);

  const prefItems: { key: keyof NotificationPrefs; label: string; description: string; icon: keyof typeof Feather.glyphMap; color: string }[] = [
    { key: "roomReady", label: "Room Ready", description: "When your room has been cleaned", icon: "check-circle", color: colors.success },
    { key: "activity", label: "Activities & Events", description: "Programs and retreat activities", icon: "calendar", color: colors.primary },
    { key: "checkoutReminder", label: "Check-out Reminders", description: "Reminders about departure time", icon: "clock", color: colors.warning },
    { key: "general", label: "General Messages", description: "Other updates from the village", icon: "bell", color: colors.accent },
  ];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Settings</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPad + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {guest && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>YOUR STAY</Text>
            <View style={styles.profileRow}>
              <View style={[styles.avatar, { backgroundColor: colors.primary + "20" }]}>
                <Feather name="user" size={24} color={colors.primary} />
              </View>
              <View style={styles.profileInfo}>
                <Text style={[styles.profileName, { color: colors.foreground }]}>{guest.name}</Text>
                <Text style={[styles.profileRoom, { color: colors.mutedForeground }]}>
                  {guest.accommodationType === "camping_site"
                    ? `Campsite ${guest.roomNumber}`
                    : guest.accommodationType === "cabin"
                    ? `Cabin ${guest.roomNumber}`
                    : `Room ${guest.roomNumber}`}
                </Text>
                {guest.mobile ? (
                  <Text style={[styles.profileMobileLine, { color: colors.mutedForeground }]}>
                    {`Mobile: ${guest.mobile}`}
                  </Text>
                ) : (
                  <Text style={[styles.profileMobileLine, { color: colors.warning }]}>
                    No mobile on file — tap Edit to add one for SMS updates.
                  </Text>
                )}
              </View>
              <Pressable
                onPress={openEditProfile}
                style={({ pressed }) => [
                  styles.editProfileBtn,
                  { borderColor: colors.border, backgroundColor: colors.muted, opacity: pressed ? 0.75 : 1 },
                ]}
              >
                <Feather name="edit-2" size={14} color={colors.mutedForeground} />
                <Text style={[styles.editProfileBtnText, { color: colors.foreground }]}>Edit</Text>
              </Pressable>
            </View>
          </View>
        )}

        {notifStatus !== "granted" && Platform.OS !== "web" && (
          <View style={[styles.card, { backgroundColor: colors.warning + "15", borderColor: colors.warning + "40" }]}>
            <View style={styles.warningRow}>
              <Feather name="alert-circle" size={20} color={colors.warning} />
              <Text style={[styles.warningText, { color: colors.foreground }]}>
                Notifications are disabled
              </Text>
            </View>
            <Text style={[styles.warningBody, { color: colors.mutedForeground }]}>
              Enable notifications to receive updates about your room and activities.
            </Text>
            <Pressable
              onPress={requestPermissions}
              style={({ pressed }) => [
                styles.enableBtn,
                { backgroundColor: colors.warning, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Text style={[styles.enableBtnText, { color: colors.warningForeground }]}>
                Enable Notifications
              </Text>
            </Pressable>
          </View>
        )}

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>NOTIFICATION PREFERENCES</Text>
          <Text style={[styles.sectionHint, { color: colors.mutedForeground }]}>
            Choose which types of notifications you want to receive.
          </Text>
          {prefItems.map((item, idx) => (
            <View
              key={item.key}
              style={[
                styles.prefRow,
                idx < prefItems.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border },
              ]}
            >
              <View style={[styles.prefIcon, { backgroundColor: item.color + "18" }]}>
                <Feather name={item.icon} size={18} color={item.color} />
              </View>
              <View style={styles.prefInfo}>
                <Text style={[styles.prefLabel, { color: colors.foreground }]}>{item.label}</Text>
                <Text style={[styles.prefDesc, { color: colors.mutedForeground }]}>{item.description}</Text>
              </View>
              <Switch
                value={prefs[item.key]}
                onValueChange={() => togglePref(item.key)}
                trackColor={{ false: colors.muted, true: item.color + "80" }}
                thumbColor={prefs[item.key] ? item.color : colors.mutedForeground}
                testID={`pref-${item.key}`}
              />
            </View>
          ))}
        </View>

        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>ABOUT</Text>
          <View style={styles.aboutRow}>
            <Feather name="map-pin" size={16} color={colors.mutedForeground} />
            <Text style={[styles.aboutText, { color: colors.mutedForeground }]}>
              525 Tyalgum Rd, Eungella NSW
            </Text>
          </View>
          <View style={styles.aboutRow}>
            <Feather name="info" size={16} color={colors.mutedForeground} />
            <Text style={[styles.aboutText, { color: colors.mutedForeground }]}>
              Krishna Village Guest App v1.0
            </Text>
          </View>
        </View>

        <Pressable
          onPress={handleClearProfile}
          style={({ pressed }) => [
            styles.clearProfileBtn,
            { borderColor: colors.destructive + "60", backgroundColor: colors.destructive + "08", opacity: pressed ? 0.7 : 1 },
          ]}
          testID="settings-clear-profile"
        >
          <Feather name="trash-2" size={18} color={colors.destructive} />
          <View style={styles.clearProfileTextGroup}>
            <Text style={[styles.clearProfileTitle, { color: colors.destructive }]}>{"Clear Profile & Re-register"}</Text>
            <Text style={[styles.clearProfileSub, { color: colors.mutedForeground }]}>Removes your profile from the system</Text>
          </View>
        </Pressable>

        <Pressable
          onPress={handleSignOut}
          style={({ pressed }) => [
            styles.signOutBtn,
            { borderColor: colors.destructive, opacity: pressed ? 0.7 : 1 },
          ]}
          testID="settings-signout"
        >
          <Feather name="log-out" size={18} color={colors.destructive} />
          <Text style={[styles.signOutText, { color: colors.destructive }]}>Sign Out</Text>
        </Pressable>
      </ScrollView>

      {/* ── Clear Profile Confirmation Modal ── */}
      <Modal
        visible={showClearConfirm}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!isClearingProfile) setShowClearConfirm(false); }}
      >
        <View style={styles.confirmOverlay}>
          <View style={[styles.confirmCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.confirmIconWrap, { backgroundColor: colors.destructive + "15" }]}>
              <Feather name="trash-2" size={26} color={colors.destructive} />
            </View>
            <Text style={[styles.confirmTitle, { color: colors.foreground }]}>
              Re-register from scratch?
            </Text>
            <Text style={[styles.confirmBody, { color: colors.mutedForeground }]}>
              This will permanently remove your profile from the system. You'll need to register again as a new guest.
            </Text>
            <View style={styles.confirmBtnRow}>
              <Pressable
                onPress={() => setShowClearConfirm(false)}
                disabled={isClearingProfile}
                style={({ pressed }) => [
                  styles.confirmCancelBtn,
                  { backgroundColor: colors.muted, opacity: pressed || isClearingProfile ? 0.6 : 1 },
                ]}
              >
                <Text style={[styles.confirmCancelText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmClear}
                disabled={isClearingProfile}
                style={({ pressed }) => [
                  styles.confirmDeleteBtn,
                  { backgroundColor: colors.destructive, opacity: pressed || isClearingProfile ? 0.7 : 1 },
                ]}
              >
                {isClearingProfile ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.confirmDeleteText}>Clear Profile</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showFarewell} transparent animationType="none" statusBarTranslucent>
        <Animated.View style={[styles.farewellOverlay, { opacity: farewellOpacity, backgroundColor: colors.background }]}>
          {farewellType === "signout" ? (
            <>
              <View style={[styles.farewellIconWrap, { backgroundColor: colors.primary + "18" }]}>
                <Feather name="log-out" size={48} color={colors.primary} />
              </View>
              <Text style={[styles.farewellTitle, { color: colors.foreground }]}>Signed out</Text>
              <Text style={[styles.farewellSub, { color: colors.mutedForeground }]}>See you soon!</Text>
            </>
          ) : (
            <>
              <View style={[styles.farewellIconWrap, { backgroundColor: colors.success + "18" }]}>
                <Feather name="check-circle" size={48} color={colors.success} />
              </View>
              <Text style={[styles.farewellTitle, { color: colors.foreground }]}>Profile cleared</Text>
              <Text style={[styles.farewellSub, { color: colors.mutedForeground }]}>See you next time!</Text>
            </>
          )}
        </Animated.View>
      </Modal>

      {/* ── Edit profile modal ── */}
      <Modal
        visible={editProfileOpen}
        animationType="fade"
        transparent
        onRequestClose={() => !isSavingProfile && setEditProfileOpen(false)}
      >
        <View style={stylesEdit.modalOverlay}>
          <View style={[stylesEdit.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[stylesEdit.modalTitle, { color: colors.foreground }]}>Update your profile</Text>
            <Text style={[stylesEdit.modalBody, { color: colors.mutedForeground }]}>
              These details let reception send you SMS notifications about your stay.
            </Text>

            <Text style={[stylesEdit.fieldLabel, { color: colors.foreground, marginTop: 16 }]}>Type</Text>
            <View style={[stylesEdit.typePickerRow, { borderColor: colors.border, backgroundColor: colors.muted }]}>
              {(["room", "cabin", "camping_site"] as const).map((t) => {
                const active = editType === t;
                const label = t === "room" ? "Room" : t === "cabin" ? "Cabin" : "Camping";
                return (
                  <Pressable
                    key={t}
                    onPress={() => setEditType(t)}
                    style={[stylesEdit.typePickerBtn, active && { backgroundColor: colors.card }]}
                  >
                    <Text style={[stylesEdit.typePickerBtnText, { color: active ? colors.primary : colors.mutedForeground }]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {editType === "camping_site" && (
              <>
                <Text style={[stylesEdit.fieldLabel, { color: colors.foreground, marginTop: 12 }]}>Arrival date</Text>
                <View style={[stylesEdit.inputWrap, { borderColor: colors.input ?? colors.border, backgroundColor: colors.muted }]}>
                  <TextInput
                    style={[stylesEdit.input, { color: colors.foreground }]}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.mutedForeground}
                    value={editArrival}
                    onChangeText={setEditArrival}
                  />
                </View>
              </>
            )}

            <Text style={[stylesEdit.fieldLabel, { color: colors.foreground, marginTop: 12 }]}>Mobile</Text>
            <View style={[stylesEdit.inputWrap, { borderColor: colors.input ?? colors.border, backgroundColor: colors.muted }]}>
              <TextInput
                style={[stylesEdit.input, { color: colors.foreground }]}
                placeholder="0412 345 678"
                placeholderTextColor={colors.mutedForeground}
                value={editMobile}
                onChangeText={setEditMobile}
                keyboardType="phone-pad"
              />
            </View>
            <Text style={[stylesEdit.helpText, { color: colors.mutedForeground }]}>
              Outbound only — replies aren't received. Contact Reception for two-way help.
            </Text>

            {editError && (
              <Text style={[stylesEdit.errText, { color: colors.destructive }]}>{editError}</Text>
            )}

            <View style={stylesEdit.modalActions}>
              <Pressable
                onPress={() => setEditProfileOpen(false)}
                disabled={isSavingProfile}
                style={({ pressed }) => [
                  stylesEdit.modalBtnSecondary,
                  { borderColor: colors.border, opacity: pressed ? 0.8 : 1 },
                ]}
              >
                <Text style={[stylesEdit.modalBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={saveProfile}
                disabled={isSavingProfile}
                style={({ pressed }) => [
                  stylesEdit.modalBtnPrimary,
                  { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
                ]}
              >
                <Text style={[stylesEdit.modalBtnText, { color: colors.primaryForeground }]}>
                  {isSavingProfile ? "Saving…" : "Save"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 14,
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  sectionHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: -4,
    lineHeight: 17,
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  profileInfo: {
    flex: 1,
    gap: 2,
  },
  profileName: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  profileRoom: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  warningRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  warningText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  warningBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  enableBtn: {
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  enableBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  prefRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    gap: 12,
  },
  prefIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  prefInfo: {
    flex: 1,
    gap: 2,
  },
  prefLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  prefDesc: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  aboutRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  aboutText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  clearProfileBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 4,
  },
  clearProfileTextGroup: {
    flex: 1,
    gap: 2,
  },
  clearProfileTitle: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  clearProfileSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  signOutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderWidth: 1.5,
    borderRadius: 14,
    height: 50,
    marginTop: 4,
  },
  signOutText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  farewellOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  farewellIconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  farewellTitle: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  farewellSub: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
  },
  confirmOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  confirmCard: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 20,
    borderWidth: 1,
    padding: 24,
    alignItems: "center",
    gap: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  confirmIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    textAlign: "center",
  },
  confirmBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 21,
  },
  confirmBtnRow: {
    flexDirection: "row",
    gap: 10,
    width: "100%",
    marginTop: 4,
  },
  confirmCancelBtn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmCancelText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
  },
  confirmDeleteBtn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  confirmDeleteText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#fff",
  },
  profileMobileLine: { fontSize: 13, marginTop: 4 },
  editProfileBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  editProfileBtnText: { fontSize: 13, fontWeight: "600" },
});


const stylesEdit = StyleSheet.create({
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  modalCard: { width: "100%", maxWidth: 420, borderRadius: 14, borderWidth: 1, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "700" },
  modalBody: { fontSize: 13, marginTop: 4, lineHeight: 18 },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 20 },
  modalBtnSecondary: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: 1 },
  modalBtnPrimary: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 },
  modalBtnText: { fontSize: 14, fontWeight: "600" },
  typePickerRow: { flexDirection: "row", borderWidth: 1, borderRadius: 10, padding: 4, gap: 4, marginTop: 6 },
  typePickerBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 8, borderRadius: 8 },
  typePickerBtnText: { fontSize: 13, fontWeight: "600" },
  inputWrap: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, marginTop: 6 },
  input: { flex: 1, paddingVertical: 10, fontSize: 14 },
  fieldLabel: { fontSize: 13, fontWeight: "600" },
  helpText: { fontSize: 11, marginTop: 6, lineHeight: 15 },
  errText: { fontSize: 13, marginTop: 12 },
});
