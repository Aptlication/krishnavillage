import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import React, { useEffect, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
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
import { playSuccessChime } from "@/lib/sound";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

type Urgency = "urgent" | "non_urgent";
type SubmitState = "idle" | "loading" | "success" | "error";

const MAX_PHOTOS = 3;

// Module-level flag so the fee-disclosure modal only shows once per app session
// (resets when the browser tab is closed or the React Native process restarts).
let feeWarningSeenThisSession = false;

function deriveDefaultSurname(fullName: string | undefined | null): string {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName.trim();
}

function normaliseMobile(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!cleaned) return null;
  if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;
  if (/^0\d{9}$/.test(cleaned)) return `+61${cleaned.slice(1)}`;
  if (/^61\d{9}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

async function pickImage(source: "camera" | "library"): Promise<string | null> {
  const granted =
    source === "camera"
      ? (await ImagePicker.requestCameraPermissionsAsync()).status === "granted"
      : (await ImagePicker.requestMediaLibraryPermissionsAsync()).status === "granted";
  if (!granted) return null;

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: "images",
    quality: 0.6,
    base64: true,
    allowsEditing: true,
    aspect: [4, 3],
  };
  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  if (!asset.base64) return null;
  const mime = asset.uri.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${asset.base64}`;
}

export default function HousekeepingScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { guest } = useGuest();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState<Urgency>("non_urgent");
  const [photos, setPhotos] = useState<string[]>([]);
  const [previewPhoto, setPreviewPhoto] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const [guestSurname, setGuestSurname] = useState<string>(deriveDefaultSurname(guest?.name));
  const [guestMobile, setGuestMobile] = useState<string>(guest?.mobile ?? "");

  // Fee-disclosure modal — shown on first entry per session so guests are
  // explicitly informed before submitting a chargeable request.
  const [showFeeWarning, setShowFeeWarning] = useState(!feeWarningSeenThisSession);

  // Sync defaults from the registered guest record if they show up after mount.
  useEffect(() => {
    if (guest?.name && !guestSurname) setGuestSurname(deriveDefaultSurname(guest.name));
  }, [guest?.name, guestSurname]);
  useEffect(() => {
    if (guest?.mobile && !guestMobile) setGuestMobile(guest.mobile);
  }, [guest?.mobile, guestMobile]);

  const topPad = Platform.OS === "android" ? insets.top : insets.top;
  const bottomPad = Platform.OS === "android" ? insets.bottom : insets.bottom;
  const canSubmit =
    !!guest &&
    title.trim().length > 0 &&
    description.trim().length > 0 &&
    submitState !== "loading";

  function showPhotoSourcePicker() {
    if (photos.length >= MAX_PHOTOS) return;
    const doAction = async (source: "camera" | "library") => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const dataUri = await pickImage(source);
      if (dataUri) setPhotos((prev) => [...prev, dataUri].slice(0, MAX_PHOTOS));
    };
    if (Platform.OS === "web") { doAction("library"); return; }
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Cancel", "Take Photo", "Choose from Library"], cancelButtonIndex: 0 },
        (idx) => { if (idx === 1) doAction("camera"); if (idx === 2) doAction("library"); },
      );
    } else {
      Alert.alert("Add Photo", "Choose a source", [
        { text: "Camera", onPress: () => doAction("camera") },
        { text: "Library", onPress: () => doAction("library") },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }

  function removePhoto(idx: number) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPhotos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    if (!canSubmit || !guest) return;
    if (!guestSurname.trim()) { setErrorMsg("Please enter your surname."); setSubmitState("error"); return; }
    const normMobile = normaliseMobile(guestMobile.trim());
    if (!normMobile) { setErrorMsg("That mobile number doesn't look right. Try 0412 345 678."); setSubmitState("error"); return; }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSubmitState("loading");
    setErrorMsg("");

    try {
      const resp = await fetchWithTenant(`${baseUrl}/api/housekeeping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: guest.name,
          roomNumber: guest.roomNumber,
          title: title.trim(),
          description: description.trim(),
          urgency,
          photos: photos.length > 0 ? photos : undefined,
          guestSurname: guestSurname.trim(),
          guestMobile: normMobile,
        }),
      });
      if (resp.status === 201) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        playSuccessChime();
        setSubmitState("success");
        setTitle(""); setDescription(""); setUrgency("non_urgent"); setPhotos([]);
      } else {
        const data = await resp.json().catch(() => ({}));
        setErrorMsg(data.error ?? "Failed to submit request. Please try again.");
        setSubmitState("error");
      }
    } catch {
      setErrorMsg("Could not connect to server. Please check your connection.");
      setSubmitState("error");
    }
  }

  function dismissFeeWarning() {
    feeWarningSeenThisSession = true;
    setShowFeeWarning(false);
  }

  return (
    <>
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Request Housekeeping</Text>
          {guest && (
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
              Room {guest.roomNumber} · {guest.name}
            </Text>
          )}
        </View>

        {submitState === "success" ? (
          <View style={[styles.successWrap, { paddingBottom: bottomPad + 80 }]}>
            <View style={[styles.successIconWrap, { backgroundColor: colors.primary + "20" }]}>
              <Feather name="check-circle" size={48} color={colors.primary} />
            </View>
            <Text style={[styles.successTitle, { color: colors.foreground }]}>Request submitted</Text>
            <Text style={[styles.successBody, { color: colors.mutedForeground }]}>
              Housekeeping has been notified. You'll receive an SMS when the request is acknowledged and again
              when it's complete.
            </Text>
            <Pressable
              onPress={() => setSubmitState("idle")}
              style={({ pressed }) => [
                styles.newReportBtn,
                { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.newReportBtnText, { color: colors.primaryForeground }]}>
                Submit another request
              </Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={[styles.form, { paddingBottom: bottomPad + 120 }]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {!guest && (
              <View style={[styles.noGuestBanner, { backgroundColor: colors.warning + "20", borderColor: colors.warning + "40" }]}>
                <Feather name="alert-circle" size={16} color={colors.warning} />
                <Text style={[styles.noGuestText, { color: colors.warning }]}>
                  Please register in Settings before requesting housekeeping.
                </Text>
              </View>
            )}

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>Your surname</Text>
              <TextInput
                value={guestSurname}
                onChangeText={setGuestSurname}
                placeholder="e.g. Sharma"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                maxLength={60}
                autoCapitalize="words"
                autoComplete="family-name"
              />
            </View>

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>Mobile number</Text>
              <TextInput
                value={guestMobile}
                onChangeText={setGuestMobile}
                placeholder="0412 345 678"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                keyboardType="phone-pad"
                autoComplete="tel"
                maxLength={20}
              />
              <Text style={[styles.helpText, { color: colors.mutedForeground }]}>
                Required — Krishna Village will SMS you status updates about this request.
              </Text>
            </View>

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>Urgency</Text>
              <View style={styles.urgencyRow}>
                <Pressable
                  onPress={() => { setUrgency("non_urgent"); Haptics.selectionAsync(); }}
                  style={[
                    styles.urgencyBtn,
                    {
                      backgroundColor: urgency === "non_urgent" ? colors.warning + "20" : colors.muted,
                      borderColor: urgency === "non_urgent" ? colors.warning : colors.border,
                      borderWidth: urgency === "non_urgent" ? 1.5 : 1,
                    },
                  ]}
                >
                  <Feather name="clock" size={18} color={urgency === "non_urgent" ? colors.warning : colors.mutedForeground} />
                  <View>
                    <Text style={[styles.urgencyLabel, { color: urgency === "non_urgent" ? colors.warning : colors.foreground }]}>
                      Non-urgent
                    </Text>
                    <Text style={[styles.urgencyHint, { color: colors.mutedForeground }]}>Attend when convenient</Text>
                  </View>
                </Pressable>
                <Pressable
                  onPress={() => { setUrgency("urgent"); Haptics.selectionAsync(); }}
                  style={[
                    styles.urgencyBtn,
                    {
                      backgroundColor: urgency === "urgent" ? colors.destructive + "15" : colors.muted,
                      borderColor: urgency === "urgent" ? colors.destructive : colors.border,
                      borderWidth: urgency === "urgent" ? 1.5 : 1,
                    },
                  ]}
                >
                  <Feather name="alert-triangle" size={18} color={urgency === "urgent" ? colors.destructive : colors.mutedForeground} />
                  <View>
                    <Text style={[styles.urgencyLabel, { color: urgency === "urgent" ? colors.destructive : colors.foreground }]}>
                      Urgent
                    </Text>
                    <Text style={[styles.urgencyHint, { color: colors.mutedForeground }]}>Needs immediate attention</Text>
                  </View>
                </Pressable>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>What do you need?</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Extra towels, full room clean, linen change"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.input, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                maxLength={100}
              />
            </View>

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>Details</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="Describe what you need and any preferences (e.g. preferred time, anything to avoid)"
                placeholderTextColor={colors.mutedForeground}
                style={[styles.textArea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]}
                multiline
                numberOfLines={5}
                maxLength={500}
                textAlignVertical="top"
              />
              <Text style={[styles.charCount, { color: colors.mutedForeground }]}>{description.length}/500</Text>
            </View>

            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>Photos (optional)</Text>
              <View style={styles.photoRow}>
                {photos.map((p, idx) => (
                  <Pressable key={idx} onPress={() => setPreviewPhoto(p)} onLongPress={() => removePhoto(idx)}>
                    <Image source={{ uri: p }} style={styles.photoThumb} contentFit="cover" />
                    <Pressable
                      onPress={() => removePhoto(idx)}
                      style={[styles.photoRemove, { backgroundColor: colors.destructive }]}
                    >
                      <Feather name="x" size={12} color="#fff" />
                    </Pressable>
                  </Pressable>
                ))}
                {photos.length < MAX_PHOTOS && (
                  <Pressable
                    onPress={showPhotoSourcePicker}
                    style={[styles.photoAdd, { borderColor: colors.border, backgroundColor: colors.muted }]}
                  >
                    <Feather name="camera" size={20} color={colors.mutedForeground} />
                  </Pressable>
                )}
              </View>
            </View>

            {errorMsg ? (
              <View style={[styles.errorBanner, { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "30" }]}>
                <Feather name="alert-circle" size={14} color={colors.destructive} />
                <Text style={[styles.errorText, { color: colors.destructive }]}>{errorMsg}</Text>
              </View>
            ) : null}

            <Pressable
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.submitBtn,
                {
                  backgroundColor: canSubmit ? colors.primary : colors.muted,
                  opacity: pressed && canSubmit ? 0.85 : 1,
                },
              ]}
            >
              {submitState === "loading" ? (
                <ActivityIndicator color={colors.primaryForeground} size="small" />
              ) : (
                <Text style={[styles.submitBtnText, { color: canSubmit ? colors.primaryForeground : colors.mutedForeground }]}>
                  Submit request
                </Text>
              )}
            </Pressable>
          </ScrollView>
        )}
      </KeyboardAvoidingView>

      {/* ── Fee-disclosure modal ─────────────────────────────────────────── */}
      <Modal
        visible={showFeeWarning}
        animationType="fade"
        transparent
        onRequestClose={dismissFeeWarning}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[styles.modalIconWrap, { backgroundColor: colors.warning + "20" }]}>
              <Feather name="info" size={28} color={colors.warning} />
            </View>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              About housekeeping fees
            </Text>
            <Text style={[styles.modalBody, { color: colors.mutedForeground }]}>
              Additional housekeeping services may attract additional fees. Before any charges
              are applied, housekeeping will contact you to confirm and obtain your agreement.
            </Text>
            <Text style={[styles.modalBody, { color: colors.mutedForeground, marginTop: 8 }]}>
              You'll never be billed for a service without your explicit approval first.
            </Text>
            <Pressable
              onPress={dismissFeeWarning}
              style={({ pressed }) => [
                styles.modalBtn,
                { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={[styles.modalBtnText, { color: colors.primaryForeground }]}>
                I understand — continue
              </Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Photo preview */}
      <Modal visible={!!previewPhoto} animationType="fade" transparent onRequestClose={() => setPreviewPhoto(null)}>
        <Pressable style={styles.previewOverlay} onPress={() => setPreviewPhoto(null)}>
          {previewPhoto && <Image source={{ uri: previewPhoto }} style={styles.previewImage} contentFit="contain" />}
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 16, borderBottomWidth: 1 },
  headerTitle: { fontSize: 26, fontWeight: "700" },
  headerSub: { fontSize: 13, marginTop: 4 },

  form: { paddingHorizontal: 20, paddingTop: 16, gap: 4 },
  section: { marginBottom: 16 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  textArea: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, minHeight: 110 },
  charCount: { fontSize: 11, marginTop: 4, textAlign: "right" },
  helpText: { fontSize: 11, marginTop: 6, lineHeight: 15 },

  urgencyRow: { flexDirection: "row", gap: 10 },
  urgencyBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1,
  },
  urgencyLabel: { fontSize: 14, fontWeight: "600" },
  urgencyHint: { fontSize: 11, marginTop: 1 },

  photoRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  photoThumb: { width: 80, height: 80, borderRadius: 8 },
  photoRemove: {
    position: "absolute", top: -4, right: -4, width: 22, height: 22, borderRadius: 11,
    alignItems: "center", justifyContent: "center",
  },
  photoAdd: {
    width: 80, height: 80, borderRadius: 8, borderWidth: 1, borderStyle: "dashed",
    alignItems: "center", justifyContent: "center",
  },

  errorBanner: {
    flexDirection: "row", alignItems: "center", gap: 8, padding: 10,
    borderRadius: 8, borderWidth: 1, marginBottom: 12,
  },
  errorText: { flex: 1, fontSize: 13 },

  submitBtn: { paddingVertical: 14, borderRadius: 10, alignItems: "center", marginTop: 4 },
  submitBtnText: { fontSize: 15, fontWeight: "600" },

  successWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 16 },
  successIconWrap: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center" },
  successTitle: { fontSize: 22, fontWeight: "700", textAlign: "center" },
  successBody: { fontSize: 14, textAlign: "center", lineHeight: 20 },
  newReportBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10, marginTop: 12 },
  newReportBtnText: { fontSize: 14, fontWeight: "600" },

  noGuestBanner: {
    flexDirection: "row", alignItems: "center", gap: 8, padding: 12,
    borderRadius: 8, borderWidth: 1, marginBottom: 12,
  },
  noGuestText: { flex: 1, fontSize: 13, fontWeight: "500" },

  modalOverlay: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", paddingHorizontal: 24,
  },
  modalCard: {
    width: "100%", maxWidth: 420, borderRadius: 16, borderWidth: 1, padding: 24, alignItems: "center",
  },
  modalIconWrap: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  modalBody: { fontSize: 14, lineHeight: 20, textAlign: "center", marginTop: 8 },
  modalBtn: { marginTop: 20, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  modalBtnText: { fontSize: 14, fontWeight: "600" },

  previewOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  previewImage: { width: "100%", height: "100%" },
});
