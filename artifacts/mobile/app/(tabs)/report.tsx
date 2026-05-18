import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import React, { useCallback, useEffect, useState } from "react";
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
type ViewMode = "form" | "history";

type MyReport = {
  id: number;
  title: string;
  description: string;
  urgency: Urgency;
  status: "open" | "in_progress" | "resolved";
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

const MAX_PHOTOS = 3;

async function requestPermissions(source: "camera" | "library"): Promise<boolean> {
  if (source === "camera") {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    return status === "granted";
  } else {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    return status === "granted";
  }
}

async function pickImage(source: "camera" | "library"): Promise<string | null> {
  const granted = await requestPermissions(source);
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

  // Determine mime type from uri or default to jpeg
  const mime = asset.uri.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${asset.base64}`;
}


/** Take the last whitespace-separated token of the registered name as the
 *  surname suggestion. Reception often records just a surname, in which case
 *  the whole field is returned. */
function deriveDefaultSurname(fullName: string | undefined | null): string {
  if (!fullName) return "";
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName.trim();
}

/** Mirror the server's AU-focused phone normaliser. Returns null on invalid. */
function normaliseMobileReport(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!cleaned) return null;
  if (/^\+[1-9]\d{6,14}$/.test(cleaned)) return cleaned;
  if (/^0\d{9}$/.test(cleaned)) return `+61${cleaned.slice(1)}`;
  if (/^61\d{9}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

export default function ReportScreen() {
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
  const [view, setView] = useState<ViewMode>("form");

  // ── Mandatory guest attribution per the SMS-notifications product spec.
  //    Pre-filled from the registered guest record; staff configured these to
  //    be required so the auto-SMS can always reach the guest.
  const [guestSurname, setGuestSurname] = useState<string>(deriveDefaultSurname(guest?.name));
  const [guestMobile, setGuestMobile] = useState<string>(guest?.mobile ?? "");
  const [myReports, setMyReports] = useState<MyReport[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);

  const fetchMyReports = useCallback(async () => {
    if (!guest?.roomNumber) return;
    setReportsLoading(true);
    try {
      const resp = await fetchWithTenant(
        `${baseUrl}/api/maintenance/my-reports?roomNumber=${encodeURIComponent(guest.roomNumber)}`
      );
      if (resp.ok) {
        const data = await resp.json();
        setMyReports(Array.isArray(data) ? data : []);
      }
    } catch {
      // silently fail — history is a convenience feature
    } finally {
      setReportsLoading(false);
    }
  }, [guest?.roomNumber]);

  useEffect(() => {
    fetchMyReports();
  }, [fetchMyReports]);

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const bottomPad = insets.bottom + (Platform.OS === "web" ? 34 : 0);

  const canSubmit = title.trim().length > 0 && description.trim().length > 0 && !!guest;


  // Keep the surname / mobile defaults in sync with the registered guest
  // record. Only overwrites when the user hasn't edited the field yet (so we
  // don't blow away a manual correction).
  useEffect(() => {
    if (guest?.name && !guestSurname) setGuestSurname(deriveDefaultSurname(guest.name));
  }, [guest?.name, guestSurname]);
  useEffect(() => {
    if (guest?.mobile && !guestMobile) setGuestMobile(guest.mobile);
  }, [guest?.mobile, guestMobile]);

  function showPhotoSourcePicker() {
    if (photos.length >= MAX_PHOTOS) return;

    const doAction = async (source: "camera" | "library") => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      const dataUri = await pickImage(source);
      if (dataUri) {
        setPhotos((prev) => [...prev, dataUri].slice(0, MAX_PHOTOS));
      }
    };

    if (Platform.OS === "web") {
      // Web only has library access
      doAction("library");
      return;
    }

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: ["Cancel", "Take Photo", "Choose from Library"], cancelButtonIndex: 0 },
        (idx) => {
          if (idx === 1) doAction("camera");
          if (idx === 2) doAction("library");
        },
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

    // Mandatory surname + mobile validation. Server rejects too, but we surface
    // it inline so the guest doesn't have to scroll for the error banner.
    if (!guestSurname.trim()) {
      setErrorMsg("Please enter your surname.");
      setSubmitState("error");
      return;
    }
    const normMobile = normaliseMobileReport(guestMobile.trim());
    if (!normMobile) {
      setErrorMsg("That mobile number doesn't look right. Try 0412 345 678.");
      setSubmitState("error");
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSubmitState("loading");
    setErrorMsg("");

    try {
      const resp = await fetchWithTenant(`${baseUrl}/api/maintenance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: guest.name,
          roomNumber: guest.roomNumber,
          title: title.trim(),
          description: description.trim(),
          urgency,
          photos: photos.length > 0 ? photos : undefined,
          // Mandatory per the SMS feature spec — see api-server's guest-submit
          // handlers which reject 400 if these are missing/invalid.
          guestSurname: guestSurname.trim(),
          guestMobile: normMobile,
        }),
      });

      if (resp.status === 201) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        playSuccessChime();
        setSubmitState("success");
        setTitle("");
        setDescription("");
        setUrgency("non_urgent");
        setPhotos([]);
        fetchMyReports();
      } else {
        const data = await resp.json().catch(() => ({}));
        setErrorMsg(data.error ?? "Failed to submit report. Please try again.");
        setSubmitState("error");
      }
    } catch {
      setErrorMsg("Could not connect to server. Please check your connection.");
      setSubmitState("error");
    }
  }

  function handleNewReport() {
    setSubmitState("idle");
    setErrorMsg("");
  }

  return (
    <>
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.header,
            { paddingTop: topPad + 16, borderBottomColor: colors.border },
          ]}
        >
          <View style={styles.headerTop}>
            <View>
              <Text style={[styles.headerTitle, { color: colors.foreground }]}>
                Report a Fault
              </Text>
              {guest && (
                <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
                  Room {guest.roomNumber} · {guest.name}
                </Text>
              )}
            </View>
          </View>

          {/* Tab toggle */}
          <View style={[styles.tabRow, { backgroundColor: colors.muted }]}>
            <Pressable
              onPress={() => { setView("form"); setSubmitState("idle"); }}
              style={[
                styles.tabBtn,
                view === "form" && { backgroundColor: colors.background },
              ]}
            >
              <Text style={[
                styles.tabBtnText,
                { color: view === "form" ? colors.foreground : colors.mutedForeground },
              ]}>
                New Report
              </Text>
            </Pressable>
            <Pressable
              onPress={() => { setView("history"); fetchMyReports(); }}
              style={[
                styles.tabBtn,
                view === "history" && { backgroundColor: colors.background },
              ]}
            >
              <Text style={[
                styles.tabBtnText,
                { color: view === "history" ? colors.foreground : colors.mutedForeground },
              ]}>
                My Reports{myReports.length > 0 ? ` (${myReports.length})` : ""}
              </Text>
            </Pressable>
          </View>
        </View>

        {view === "history" ? (
          <ScrollView
            contentContainerStyle={[styles.form, { paddingBottom: bottomPad + 120 }]}
            showsVerticalScrollIndicator={false}
          >
            {reportsLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
            ) : myReports.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Text style={[styles.emptyHistoryIcon]}>🔧</Text>
                <Text style={[styles.emptyHistoryTitle, { color: colors.foreground }]}>
                  No reports yet
                </Text>
                <Text style={[styles.emptyHistoryBody, { color: colors.mutedForeground }]}>
                  Your submitted maintenance reports will appear here.
                </Text>
              </View>
            ) : (
              myReports.map((report) => {
                const statusLabel =
                  report.status === "open" ? "Submitted" :
                  report.status === "in_progress" ? "In Progress" : "Resolved";
                const statusColor =
                  report.status === "open" ? colors.primary :
                  report.status === "in_progress" ? colors.warning : colors.success;
                const statusBg =
                  report.status === "open" ? colors.primary + "15" :
                  report.status === "in_progress" ? colors.warning + "15" : colors.success + "15";
                const date = new Date(report.createdAt).toLocaleDateString("en-AU", {
                  day: "numeric", month: "short", year: "numeric",
                });

                return (
                  <View
                    key={report.id}
                    style={[styles.reportCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <View style={styles.reportCardTop}>
                      <Text style={[styles.reportCardTitle, { color: colors.foreground }]} numberOfLines={2}>
                        {report.title}
                      </Text>
                      <View style={[styles.statusBadge, { backgroundColor: statusBg }]}>
                        <Text style={[styles.statusBadgeText, { color: statusColor }]}>
                          {statusLabel}
                        </Text>
                      </View>
                    </View>
                    <Text style={[styles.reportCardDesc, { color: colors.mutedForeground }]} numberOfLines={2}>
                      {report.description}
                    </Text>
                    <View style={styles.reportCardMeta}>
                      <Text style={[styles.reportCardDate, { color: colors.mutedForeground }]}>
                        {date} · {report.urgency === "urgent" ? "Urgent" : "Non-urgent"}
                      </Text>
                    </View>
                    {report.resolutionNote && (
                      <View style={[styles.resolutionNote, { backgroundColor: colors.success + "10", borderColor: colors.success + "30" }]}>
                        <Text style={[styles.resolutionNoteLabel, { color: colors.success }]}>Staff note</Text>
                        <Text style={[styles.resolutionNoteText, { color: colors.foreground }]}>
                          {report.resolutionNote}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })
            )}
          </ScrollView>
        ) : submitState === "success" ? (
          <View style={styles.centered}>
            <View style={[styles.successIcon, { backgroundColor: colors.success + "20" }]}>
              <Feather name="check-circle" size={48} color={colors.success} />
            </View>
            <Text style={[styles.successTitle, { color: colors.foreground }]}>
              Report submitted
            </Text>
            <Text style={[styles.successBody, { color: colors.mutedForeground }]}>
              Our maintenance team has been notified and will attend to it as soon as possible.
            </Text>
            <Pressable
              onPress={() => { setView("history"); setSubmitState("idle"); }}
              style={[styles.newReportBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={[styles.newReportBtnText, { color: colors.primaryForeground }]}>
                View my reports
              </Text>
            </Pressable>
            <Pressable
              onPress={handleNewReport}
              style={[styles.newReportBtn, { backgroundColor: colors.muted, marginTop: 8 }]}
            >
              <Text style={[styles.newReportBtnText, { color: colors.foreground }]}>
                Submit another report
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
              <View
                style={[
                  styles.noGuestBanner,
                  { backgroundColor: colors.warning + "20", borderColor: colors.warning + "40" },
                ]}
              >
                <Feather name="alert-circle" size={16} color={colors.warning} />
                <Text style={[styles.noGuestText, { color: colors.warning }]}>
                  Please register in Settings before submitting a report.
                </Text>
              </View>
            )}

            {/* Mandatory guest attribution — surname + mobile. Pre-filled from
                the registered guest record but editable; server rejects empty/
                invalid values. */}
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
              <Text style={[styles.charCount, { color: colors.mutedForeground }]}>
                Required — Krishna Village will SMS you status updates about this request.
              </Text>
            </View>

            {/* Urgency */}
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
                  <Feather
                    name="clock"
                    size={18}
                    color={urgency === "non_urgent" ? colors.warning : colors.mutedForeground}
                  />
                  <View>
                    <Text
                      style={[
                        styles.urgencyLabel,
                        { color: urgency === "non_urgent" ? colors.warning : colors.foreground },
                      ]}
                    >
                      Non-urgent
                    </Text>
                    <Text style={[styles.urgencyHint, { color: colors.mutedForeground }]}>
                      Attend when convenient
                    </Text>
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
                  <Feather
                    name="alert-triangle"
                    size={18}
                    color={urgency === "urgent" ? colors.destructive : colors.mutedForeground}
                  />
                  <View>
                    <Text
                      style={[
                        styles.urgencyLabel,
                        { color: urgency === "urgent" ? colors.destructive : colors.foreground },
                      ]}
                    >
                      Urgent
                    </Text>
                    <Text style={[styles.urgencyHint, { color: colors.mutedForeground }]}>
                      Needs immediate attention
                    </Text>
                  </View>
                </Pressable>
              </View>
            </View>

            {/* Issue title */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>
                What is the issue?
              </Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Leaking tap, broken light, no hot water"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.input,
                  { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
                ]}
                maxLength={100}
                returnKeyType="next"
              />
            </View>

            {/* Details */}
            <View style={styles.section}>
              <Text style={[styles.label, { color: colors.foreground }]}>Details</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder="Describe where the issue is and anything else that might help our team"
                placeholderTextColor={colors.mutedForeground}
                style={[
                  styles.textArea,
                  { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
                ]}
                multiline
                numberOfLines={5}
                maxLength={500}
                textAlignVertical="top"
              />
              <Text style={[styles.charCount, { color: colors.mutedForeground }]}>
                {description.length}/500
              </Text>
            </View>

            {/* Photo upload */}
            <View style={styles.section}>
              <View style={styles.photoLabelRow}>
                <Text style={[styles.label, { color: colors.foreground }]}>
                  Photos
                </Text>
                <Text style={[styles.photoHint, { color: colors.mutedForeground }]}>
                  Optional · up to {MAX_PHOTOS}
                </Text>
              </View>

              <View style={styles.photoGrid}>
                {photos.map((uri, idx) => (
                  <Pressable
                    key={idx}
                    onPress={() => setPreviewPhoto(uri)}
                    style={[styles.photoThumb, { borderColor: colors.border }]}
                  >
                    <Image
                      source={{ uri }}
                      style={styles.photoThumbImage}
                      contentFit="cover"
                    />
                    <Pressable
                      onPress={() => removePhoto(idx)}
                      style={[styles.photoRemoveBtn, { backgroundColor: colors.destructive }]}
                      hitSlop={4}
                    >
                      <Feather name="x" size={10} color="#fff" />
                    </Pressable>
                  </Pressable>
                ))}

                {photos.length < MAX_PHOTOS && (
                  <Pressable
                    onPress={showPhotoSourcePicker}
                    style={[
                      styles.photoAddBtn,
                      { backgroundColor: colors.muted, borderColor: colors.border },
                    ]}
                  >
                    <Feather name="camera" size={22} color={colors.mutedForeground} />
                    <Text style={[styles.photoAddText, { color: colors.mutedForeground }]}>
                      Add photo
                    </Text>
                  </Pressable>
                )}
              </View>
            </View>

            {submitState === "error" && (
              <View
                style={[
                  styles.errorBanner,
                  { backgroundColor: colors.destructive + "15", borderColor: colors.destructive + "30" },
                ]}
              >
                <Feather name="alert-circle" size={14} color={colors.destructive} />
                <Text style={[styles.errorText, { color: colors.destructive }]}>
                  {errorMsg}
                </Text>
              </View>
            )}

            <Pressable
              onPress={handleSubmit}
              disabled={!canSubmit || submitState === "loading"}
              style={({ pressed }) => [
                styles.submitBtn,
                {
                  backgroundColor: canSubmit ? colors.primary : colors.muted,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              {submitState === "loading" ? (
                <ActivityIndicator color={colors.primaryForeground} size="small" />
              ) : (
                <>
                  <Feather
                    name="send"
                    size={18}
                    color={canSubmit ? colors.primaryForeground : colors.mutedForeground}
                  />
                  <Text
                    style={[
                      styles.submitBtnText,
                      { color: canSubmit ? colors.primaryForeground : colors.mutedForeground },
                    ]}
                  >
                    Submit report
                  </Text>
                </>
              )}
            </Pressable>
          </ScrollView>
        )}
      </KeyboardAvoidingView>

      {/* Full-screen photo preview */}
      <Modal
        visible={!!previewPhoto}
        animationType="fade"
        transparent
        onRequestClose={() => setPreviewPhoto(null)}
      >
        <Pressable
          style={styles.previewOverlay}
          onPress={() => setPreviewPhoto(null)}
        >
          {previewPhoto && (
            <Image
              source={{ uri: previewPhoto }}
              style={styles.previewImage}
              contentFit="contain"
            />
          )}
          <Pressable
            style={[styles.previewClose, { backgroundColor: colors.card }]}
            onPress={() => setPreviewPhoto(null)}
          >
            <Feather name="x" size={20} color={colors.foreground} />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingTop: 4,
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  headerSub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  tabRow: {
    flexDirection: "row",
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  tabBtnText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  emptyHistory: {
    alignItems: "center",
    paddingTop: 60,
    gap: 10,
    paddingHorizontal: 40,
  },
  emptyHistoryIcon: {
    fontSize: 44,
    marginBottom: 4,
  },
  emptyHistoryTitle: {
    fontSize: 18,
    fontFamily: "Inter_600SemiBold",
  },
  emptyHistoryBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 20,
  },
  reportCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
    gap: 6,
  },
  reportCardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    justifyContent: "space-between",
  },
  reportCardTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    lineHeight: 20,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    flexShrink: 0,
  },
  statusBadgeText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
  },
  reportCardDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  reportCardMeta: {
    marginTop: 2,
  },
  reportCardDate: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  resolutionNote: {
    marginTop: 6,
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    gap: 3,
  },
  resolutionNoteLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  resolutionNoteText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 16,
  },
  successIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  successTitle: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    textAlign: "center",
  },
  successBody: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
    lineHeight: 22,
  },
  newReportBtn: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 8,
  },
  newReportBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  form: {
    padding: 20,
    gap: 4,
  },
  noGuestBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  noGuestText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  section: {
    gap: 8,
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  urgencyRow: {
    flexDirection: "row",
    gap: 10,
  },
  urgencyBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderRadius: 12,
  },
  urgencyLabel: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  urgencyHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    marginTop: 1,
  },
  input: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    minHeight: 120,
  },
  charCount: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    textAlign: "right",
    marginTop: -4,
  },
  photoLabelRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  photoHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
  photoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  photoThumb: {
    width: 90,
    height: 90,
    borderRadius: 10,
    overflow: "hidden",
    borderWidth: 1,
  },
  photoThumbImage: {
    width: "100%",
    height: "100%",
  },
  photoRemoveBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  photoAddBtn: {
    width: 90,
    height: 90,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  photoAddText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    textAlign: "center",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
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
  previewOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  previewImage: {
    width: "100%",
    height: "80%",
  },
  previewClose: {
    position: "absolute",
    top: 60,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
});
