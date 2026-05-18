import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Image,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors } from "@/hooks/useColors";
import { useGuest } from "@/context/GuestContext";
import { fetchWithTenant } from "@/lib/fetchWithTenant";

const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

const DEFAULT_DRIVER_PHONE = process.env.EXPO_PUBLIC_DRIVER_PHONE ?? "+61429725165";
const DEFAULT_BUGGY_PHONE = process.env.EXPO_PUBLIC_BUGGY_PHONE ?? "+61429725165";

function formatPhoneDisplay(e164: string): string {
  const au = e164.match(/^\+61(\d{3})(\d{3})(\d{3})$/);
  if (au) return `0${au[1]} ${au[2]} ${au[3]}`;
  return e164;
}
const FARM_MAPS_URL =
  "https://maps.google.com/?q=525+Tyalgum+Rd,+Eungella+NSW+2484,+Australia";

const FALLBACK_FAQ_ITEMS = [
  {
    id: -1,
    q: "What are the check-in and check-out times?",
    a: "Check-in is from 1:30 pm to 4:30 pm. If you are arriving after 4:30 pm, please check your inbox for an email with arrival instructions and an up-to-date entry code for the main gate. Self check-in after hours is possible. Check-out is by 10:00 am on your departure day.",
  },
  {
    id: -2,
    q: "When is reception open?",
    a: "Our reception is open from 9:00 am to 5:00 pm each day. If you arrive outside of staffed hours, please use the Krishna Village map to find your way around.",
  },
  {
    id: -3,
    q: "What time are meals served?",
    a: "All meals are vegetarian and served in the communal dining room. Please check the Welcome Pack or ask at reception for the current meal schedule.",
  },
  {
    id: -4,
    q: "Is there WiFi available?",
    a: "Yes, WiFi is available on site. Please note that WiFi reception for some providers can be difficult in this rural area — we recommend downloading anything you need before arriving.",
  },
  {
    id: -5,
    q: "Are there yoga classes every day?",
    a: "Yes, yoga is held daily. See the Yoga Schedule below for the current timetable. All levels are welcome — modifications are offered and instructors are happy to assist beginners.",
  },
  {
    id: -6,
    q: "Is there a risk of flash flooding?",
    a: "The Tweed Valley, including the bridge to our property, can be affected by flash flooding during extreme weather events. Our bridge floods at 1.85 m. If you are travelling in wet weather, please check the current river height for the Oxley River on the BOM website before you travel. If you are unsure, please contact us.",
  },
  {
    id: -7,
    q: "What facilities are available?",
    a: "Facilities include a yoga hall, meditation room, communal dining area, walking trails, and a sacred temple. There is no gym or swimming pool on site.",
  },
  {
    id: -8,
    q: "Can I bring visitors onto the property?",
    a: "All visitors must be registered at reception before entering the retreat grounds. Please let staff know in advance.",
  },
];

/**
 * Village Information — brochure content shown on the Services tab. Static
 * (not API-driven) so reception can update the printed brochure and the app
 * in parallel via this constant + a deploy. Items render as expandable rows
 * similar to FAQs.
 */
const VILLAGE_INFO_ITEMS: ReadonlyArray<{ icon: string; title: string; body: string }> = [
  {
    icon: "wifi",
    title: "WiFi access",
    body: "Network: KFarmFreeWiFi\nPassword: Krsna108",
  },
  {
    icon: "log-out",
    title: "Check-out",
    body: "Check-out is by 9:30 am. Please return your key and wristbands to Reception, or place them in the dropbox next to the reception door.",
  },
  {
    icon: "key",
    title: "Boom Gate",
    body: "The code is 6626. The gate closes in the late evening and reopens at 4:00 am.",
  },
  {
    icon: "coffee",
    title: "Meals",
    body: "All bookings include 3 complimentary meals per day:\n\n• Breakfast — Mon-Sun from 8:30 am at the temple\n• Lunch — Mon-Sun from 12:15 pm at the Krishna Village Dining area\n• Dinner — Mon-Sun from 6:15 pm at the temple\n\nAll meals have at least 3 gluten-free and vegan options. Please check with servers if you have allergies.",
  },
  {
    icon: "activity",
    title: "Yoga classes & workshops",
    body: "We offer three yoga classes daily, open for all guests. Doors close at the starting time — please arrive 5 minutes early to settle in. Mats and props are provided.\n\nWe also hold unique workshops daily in the Yoga Hall. Check the Weekly Schedule on the Noticeboard outside Reception for class and workshop times.",
  },
  {
    icon: "droplet",
    title: "Bathrooms",
    body: "There are two toilet and shower blocks — one next to the community kitchen and another beside the campgrounds.",
  },
  {
    icon: "refresh-cw",
    title: "Laundry",
    body: "Coin-operated washing machines and free hand-washing facilities are located at the bathroom block near the campgrounds. If you need coins, please visit Reception.",
  },
  {
    icon: "book-open",
    title: "Community Hub",
    body: "The Community Hub is next to the camping area. It includes books, games, study areas, and free WiFi. You're welcome to relax, read, or connect here during your stay.",
  },
  {
    icon: "thermometer",
    title: "Kitchen",
    body: "The kitchen is equipped with fridges, stoves, ovens, toasters, kettles, pots, pans, utensils, and a filtered water tap. Filtered rainwater is also available in the laundry room.\n\nPlease do NOT prepare meat, fish, or eggs onsite.\n\nWash your dishes after use and keep kitchenware in the kitchen.",
  },
  {
    icon: "moon",
    title: "Quiet time & non-smoking",
    body: "After 8:30 pm, the village observes quiet time — thank you for helping maintain a peaceful environment for all guests.\n\nPlease note that our property is strictly non-smoking.",
  },
  {
    icon: "home",
    title: "Temple",
    body: "Our beautiful temple offers a variety of classes and programs and you are warmly welcome to join. When visiting, please cover your knees and shoulders out of respect for the space.",
  },
  {
    icon: "heart",
    title: "KV Wellness",
    body: "Discover Deep Rest and Renewal at KV Wellness. We offer a wide range of holistic treatments including massages, Ayurvedic therapies, coaching, astrology and more.\n\nVisit www.kvwellness.com.au to view the full menu and book your treatment today.",
  },
];

const YOGA_DAYS = [
  { short: "Mon", date: "4 May" },
  { short: "Tue", date: "5 May" },
  { short: "Wed", date: "6 May" },
  { short: "Thu", date: "7 May" },
  { short: "Fri", date: "8 May" },
  { short: "Sat", date: "9 May" },
  { short: "Sun", date: "10 May" },
] as const;

type SlotKind = "yoga" | "meal" | "event";

interface YogaSlot {
  time: string;
  category: string;
  kind: SlotKind;
  sessions: string[];
}

const YOGA_SLOTS: YogaSlot[] = [
  {
    time: "5:00–6:00 am",
    category: "Early Yoga · Yoga Hall",
    kind: "yoga",
    sessions: [
      "Quinn – Slow Flow Yoga",
      "Macie – Slow Flow Yoga",
      "Kristie – Slow Flow Yoga",
      "Teacher Trainees – Slow Flow Yoga",
      "Teacher Trainees – Slow Flow Yoga",
      "Sophie – Intermediate Vinyasa",
      "Kristie – Intermediate Vinyasa",
    ],
  },
  {
    time: "6:30–8:00 am",
    category: "Morning Yoga · Yoga Hall",
    kind: "yoga",
    sessions: [
      "Rachelle – Gentle Hatha",
      "Laxmivan – Gentle Hatha",
      "Monica – Gentle Hatha",
      "Radha – Gentle Hatha",
      "Teacher Trainees – Gentle Hatha",
      "",
      "",
    ],
  },
  {
    time: "8:30–9:00 am",
    category: "Breakfast",
    kind: "meal",
    sessions: [
      "Breakfast at the Temple",
      "Breakfast at the Temple",
      "Breakfast at the Temple",
      "Breakfast at the Temple",
      "Breakfast at the Temple",
      "Breakfast at the Temple",
      "Breakfast at the Temple",
    ],
  },
  {
    time: "10:30 am–12:00 pm",
    category: "Guest Workshop · Lotus Pod",
    kind: "event",
    sessions: [
      "Welcome Tour 11am – Meet at Reception",
      "Dhama – Meditation & Healing Soundbath",
      "Deva – Introduction to Vedic Astrology",
      "Deva – Prakriti & Purusha: The Eternal Feminine & Masculine",
      "Janardhan – Introduction to the Bhagavad Gita",
      "10:00–11:00am Cow & Goshala Tour – Meet at Reception",
      "YTT Practice Session – Yoga Hall",
    ],
  },
  {
    time: "12:15–12:45 pm",
    category: "Lunch",
    kind: "meal",
    sessions: [
      "Lunch in the Village",
      "Lunch in the Village",
      "Lunch in the Village",
      "Lunch in the Village",
      "Lunch in the Village",
      "Lunch in the Village",
      "Lunch in the Village",
    ],
  },
  {
    time: "1:30–2:00 pm",
    category: "Kirtan & Meditation · Yoga Hall",
    kind: "event",
    sessions: [
      "Kirtan with Rachel & friends",
      "Kirtan with Radha Ashram & friends",
      "Kirtan with Veida & friends",
      "Kirtan with Lila, Sadhu & friends",
      "Kirtan with Jake & friends",
      "",
      "",
    ],
  },
  {
    time: "2:00–3:00 pm",
    category: "Yogic Living Class · Yoga Hall",
    kind: "event",
    sessions: [
      "Chaitanya Charan – From Negative Self-Image To Positive Self-Insight",
      "Martin – Ayurveda: The Three Doshas & Your Body Constitution",
      "Veida – Sacred Stillness: Japa Mantra Meditation Workshop",
      "Lila – Partner Yoga & Laughter Yoga",
      "Jake – Yoga Philosophy: The 8 Limbs of Ashtanga",
      "Sam – Creating Healthy Boundaries with Group Hypnosis",
      "Katha – The Art of Conscious Language",
    ],
  },
  {
    time: "4:15–5:45 pm",
    category: "Afternoon Yoga · Yoga Hall",
    kind: "yoga",
    sessions: [
      "Lila – Intermediate Hatha",
      "Laxmivan – Intermediate Hatha",
      "Teacher Trainees – Intermediate Hatha",
      "Caitlin – Gentle Hatha",
      "Jake – Intermediate Yin",
      "Caitlin – Gentle Hatha",
      "Dhama – Gentle Yin",
    ],
  },
  {
    time: "6:15–7:00 pm",
    category: "Dinner",
    kind: "meal",
    sessions: [
      "Dinner at the Temple",
      "Dinner at the Temple",
      "Dinner at the Temple",
      "Dinner at the Temple",
      "Dinner at the Temple",
      "Dinner at the Temple",
      "Dinner at the Temple",
    ],
  },
  {
    time: "7:15 pm",
    category: "Evening Session · Yoga Hall",
    kind: "event",
    sessions: [
      "Py – Sound Journey",
      "Kirtan in the Yoga Hall · 7:15–8:30pm",
      "KG – Q&A with a Bhakti Yogi · 7:15–8:30pm",
      "Dhama – The Pursuit of Happiness · 7:15–8:00pm",
      "Sam – Conscious Dance · 7:15–8:30pm",
      "Monica – Yoga Nidra Meditation · 7:15–8:00pm",
      "Caitlin – Yoga Nidra Meditation · 7:15–8:00pm",
    ],
  },
];

type ToastType = "success" | "error";

function useToast() {
  const opacity = useRef(new Animated.Value(0)).current;
  const [message, setMessage] = useState("");
  const [type, setType] = useState<ToastType>("success");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, t: ToastType) {
    if (timerRef.current) clearTimeout(timerRef.current);
    setMessage(msg);
    setType(t);
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    timerRef.current = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }).start();
    }, 3000);
  }

  return { opacity, message, type, showToast };
}

interface ApiFaqItem {
  id: number;
  question: string;
  answer: string;
  sortOrder: number;
}

export default function ServicesScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { guest } = useGuest();
  const { width: screenWidth } = useWindowDimensions();
  const { opacity: toastOpacity, message: toastMessage, type: toastType, showToast } = useToast();

  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);
  // Track which Village Information row is expanded (only one at a time, like FAQ).
  const [openInfoIndex, setOpenInfoIndex] = useState<number | null>(null);
  const [selectedDay, setSelectedDay] = useState<number>(() => {
    const dow = new Date().getDay();
    return (dow + 6) % 7;
  });

  const [dynamicFaqs, setDynamicFaqs] = useState<ApiFaqItem[] | null>(null);
  const [yogaImageUrl, setYogaImageUrl] = useState<string | null>(null);
  const [driverPhone, setDriverPhone] = useState<string>(DEFAULT_DRIVER_PHONE);
  const [buggyPhone, setBuggyPhone] = useState<string>(DEFAULT_BUGGY_PHONE);
  const [contentLoaded, setContentLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const fetchingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadContent = useCallback(async (isPullToRefresh = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    if (isPullToRefresh) setRefreshing(true);
    try {
      const [faqResp, yogaResp, contactResp] = await Promise.all([
        fetchWithTenant(`${baseUrl}/api/services/faqs`),
        fetchWithTenant(`${baseUrl}/api/services/yoga-schedule`),
        fetchWithTenant(`${baseUrl}/api/services/contact-settings`),
      ]);

      if (!mountedRef.current) return;

      if (faqResp.ok) {
        const faqs = await faqResp.json() as ApiFaqItem[];
        if (mountedRef.current) setDynamicFaqs(faqs.length > 0 ? faqs : null);
      }

      if (yogaResp.ok) {
        const yoga = await yogaResp.json() as { url: string | null };
        if (mountedRef.current) setYogaImageUrl(yoga.url ?? null);
      }

      if (contactResp.ok) {
        const contact = await contactResp.json() as { driverPhone: string | null; buggyPhone: string | null };
        if (mountedRef.current) {
          if (contact.driverPhone) setDriverPhone(contact.driverPhone);
          if (contact.buggyPhone) setBuggyPhone(contact.buggyPhone);
        }
      }

      if (mountedRef.current) setContentLoaded(true);
    } catch {
      if (mountedRef.current) setContentLoaded(true);
    } finally {
      fetchingRef.current = false;
      if (isPullToRefresh && mountedRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadContent();

    const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    function startInterval() {
      intervalId = setInterval(() => {
        if (AppState.currentState === "active") {
          loadContent();
        }
      }, REFRESH_INTERVAL_MS);
    }

    function stopInterval() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    startInterval();

    const appStateSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        loadContent();
        stopInterval();
        startInterval();
      } else {
        stopInterval();
      }
    });

    return () => {
      stopInterval();
      appStateSub.remove();
    };
  }, [loadContent]);

  const faqItems = dynamicFaqs
    ? dynamicFaqs.map((f) => ({ q: f.question, a: f.answer }))
    : FALLBACK_FAQ_ITEMS.map((f) => ({ q: f.q, a: f.a }));

  const topPad = insets.top + (Platform.OS === "web" ? 67 : 0);
  const bottomPad = insets.bottom + (Platform.OS === "web" ? 34 : 0);
  const imageWidth = screenWidth - 64;

  function toggleInfo(idx: number) {
    setOpenInfoIndex((prev) => (prev === idx ? null : idx));
  }

  function toggleFaq(idx: number) {
    Haptics.selectionAsync().catch(() => {});
    setOpenFaqIndex((prev) => (prev === idx ? null : idx));
  }

  const toastBg = toastType === "success" ? colors.success : colors.destructive;
  const toastFg = toastType === "success" ? colors.successForeground : colors.destructiveForeground;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Services</Text>
        {guest && (
          <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
            Room {guest.roomNumber} · {guest.name}
          </Text>
        )}
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomPad + 120 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadContent(true)}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      >
        {/* ── Village Information (brochure content) ──────────────────── */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            {Platform.OS === "web" ? (
              <Text style={styles.cardHeaderEmoji}>🏡</Text>
            ) : (
              <View style={[styles.cardIconWrap, { backgroundColor: colors.primary + "18" }]}>
                <Feather name="info" size={20} color={colors.primary} />
              </View>
            )}
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Village Information</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.mutedForeground, marginBottom: 8 }]}>
            Tap any item to expand. All essentials are also in your welcome brochure.
          </Text>
          {VILLAGE_INFO_ITEMS.map((item, idx) => (
            <View key={idx}>
              {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
              <Pressable
                onPress={() => toggleInfo(idx)}
                style={styles.faqRow}
                accessibilityRole="button"
                accessibilityState={{ expanded: openInfoIndex === idx }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 10 }}>
                  <Feather name={item.icon as never} size={16} color={colors.primary} />
                  <Text style={[styles.faqQuestion, { color: colors.foreground, flex: 1 }]}>
                    {item.title}
                  </Text>
                </View>
                <Feather
                  name={openInfoIndex === idx ? "chevron-up" : "chevron-down"}
                  size={18}
                  color={colors.mutedForeground}
                />
              </Pressable>
              {openInfoIndex === idx && (
                <Text style={[styles.faqAnswer, { color: colors.mutedForeground }]}>
                  {item.body}
                </Text>
              )}
            </View>
          ))}
        </View>

        {/* FAQs */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            {Platform.OS === "web" ? (
              <Text style={styles.cardHeaderEmoji}>❓</Text>
            ) : (
              <View style={[styles.cardIconWrap, { backgroundColor: colors.primary + "18" }]}>
                <Feather name="help-circle" size={20} color={colors.primary} />
              </View>
            )}
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>FAQs</Text>
          </View>
          {!contentLoaded ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 8 }} />
          ) : (
            faqItems.map((item, idx) => (
              <View key={idx}>
                {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
                <Pressable
                  onPress={() => toggleFaq(idx)}
                  style={styles.faqRow}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: openFaqIndex === idx }}
                >
                  <Text style={[styles.faqQuestion, { color: colors.foreground }]}>
                    {item.q}
                  </Text>
                  <Feather
                    name={openFaqIndex === idx ? "chevron-up" : "chevron-down"}
                    size={18}
                    color={colors.mutedForeground}
                  />
                </Pressable>
                {openFaqIndex === idx && (
                  <Text style={[styles.faqAnswer, { color: colors.mutedForeground }]}>
                    {item.a}
                  </Text>
                )}
              </View>
            ))
          )}
        </View>

        {/* Driver Services */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            {Platform.OS === "web" ? (
              <Text style={styles.cardHeaderEmoji}>🚐</Text>
            ) : (
              <View style={[styles.cardIconWrap, { backgroundColor: colors.accent + "18" }]}>
                <Feather name="truck" size={20} color={colors.accent} />
              </View>
            )}
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Driver Services</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.mutedForeground }]}>
            We offer transfers to and from Murwillumbah, Gold Coast Airport, Brisbane Airport, and Ballina Airport. Using the Krishna Village transport service offers the most competitive rates and supports our community.{"\n\n"}Rides depart from Krishna Village (Uber does not usually do transfers from Krishna Village).{"\n\n"}Please contact Charana in advance, should you need to book a transfer.
          </Text>
          <Pressable
            onPress={() => Linking.openURL(`sms:${driverPhone}`).catch(() => Linking.openURL(`tel:${driverPhone}`).catch(() => {}))}
            style={[styles.actionBtn, { backgroundColor: colors.accent }]}
          >
            <Feather name="message-square" size={16} color={colors.accentForeground} />
            <Text style={[styles.actionBtnText, { color: colors.accentForeground }]}>SMS Charana — {formatPhoneDisplay(driverPhone)}</Text>
          </Pressable>
        </View>

        {/* Housekeeping */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            {Platform.OS === "web" ? (
              <Text style={styles.cardHeaderEmoji}>🧹</Text>
            ) : (
              <View style={[styles.cardIconWrap, { backgroundColor: colors.success + "18" }]}>
                <Feather name="wind" size={20} color={colors.success} />
              </View>
            )}
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Housekeeping</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.mutedForeground }]}>
            Need fresh towels, linen, or room cleaning? Please enquire at Reception and a member of our team will assist you.
          </Text>
          <View style={[styles.infoBanner, { backgroundColor: colors.warning + "18", borderColor: colors.warning + "40" }]}>
            <Feather name="info" size={14} color={colors.warning} />
            <Text style={[styles.infoBannerText, { color: colors.warning }]}>
              All additional housekeeping requests attract an additional fee. Contact reception or order below via your 'Housekeeping' button in your app navigation settings.
            </Text>
          </View>
          <Pressable
            onPress={() => Linking.openURL(`tel:${buggyPhone}`).catch(() => {})}
            style={[styles.actionBtn, { backgroundColor: colors.primary }]}
          >
            <Feather name="phone" size={16} color={colors.primaryForeground} />
            <Text style={[styles.actionBtnText, { color: colors.primaryForeground }]}>Enquire at Reception</Text>
          </Pressable>
        </View>

        {/* Golf Buggy Hire */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            {Platform.OS === "web" ? (
              <Text style={styles.cardHeaderEmoji}>⛳</Text>
            ) : (
              <View style={[styles.cardIconWrap, { backgroundColor: colors.warning + "18" }]}>
                <Feather name="navigation" size={20} color={colors.warning} />
              </View>
            )}
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Golf Buggy Hire</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.mutedForeground }]}>
            Golf buggies are available for guests to explore the farm and reach the Temple. Buggies can be hired from reception during opening hours. A small deposit may be required.
          </Text>
          <Pressable
            onPress={() => Linking.openURL(`tel:${buggyPhone}`).catch(() => {})}
            style={[styles.actionBtn, { backgroundColor: colors.primary }]}
          >
            <Feather name="phone" size={16} color={colors.primaryForeground} />
            <Text style={[styles.actionBtnText, { color: colors.primaryForeground }]}>Enquire at Reception</Text>
          </Pressable>
        </View>

        {/* Map of Farm */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            {Platform.OS === "web" ? (
              <Text style={styles.cardHeaderEmoji}>🗺️</Text>
            ) : (
              <View style={[styles.cardIconWrap, { backgroundColor: colors.primary + "18" }]}>
                <Feather name="map" size={20} color={colors.primary} />
              </View>
            )}
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Map of Farm</Text>
          </View>
          <Text style={[styles.scheduleHint, { color: colors.mutedForeground }]}>
            {Platform.OS !== "web" ? "Pinch to zoom · scroll to explore" : "Scroll to explore"}
          </Text>
          <ScrollView
            scrollEnabled
            maximumZoomScale={4}
            minimumZoomScale={1}
            bouncesZoom={Platform.OS !== "web"}
            showsVerticalScrollIndicator={false}
            showsHorizontalScrollIndicator={false}
            style={[styles.scheduleScroll, { borderColor: colors.border }]}
            contentContainerStyle={styles.scheduleScrollContent}
          >
            <Image
              source={require("@/assets/kv-map.jpg")}
              style={{ width: imageWidth, height: imageWidth * (1497 / 1059) }}
              resizeMode="contain"
            />
          </ScrollView>
          <Pressable
            onPress={() => Linking.openURL(FARM_MAPS_URL).catch(() => {})}
            style={[styles.actionBtn, { backgroundColor: colors.muted, borderWidth: 1, borderColor: colors.border }]}
          >
            <Feather name="map-pin" size={16} color={colors.foreground} />
            <Text style={[styles.actionBtnText, { color: colors.foreground }]}>Open in Google Maps</Text>
          </Pressable>
        </View>

        {/* Yoga Schedule */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cardHeader}>
            {Platform.OS === "web" ? (
              <Text style={styles.cardHeaderEmoji}>🧘</Text>
            ) : (
              <View style={[styles.cardIconWrap, { backgroundColor: colors.success + "18" }]}>
                <Feather name="calendar" size={20} color={colors.success} />
              </View>
            )}
            <Text style={[styles.cardTitle, { color: colors.foreground }]}>Yoga Schedule</Text>
          </View>

          {!contentLoaded ? (
            <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 8 }} />
          ) : (yogaImageUrl && /\.(jpg|jpeg|png|gif|webp)$/i.test(yogaImageUrl.toLowerCase().split("?")[0])) ? (
            (() => {
              const fullUrl = yogaImageUrl.startsWith("/") ? `${baseUrl}${yogaImageUrl}` : yogaImageUrl;
              return (
                <>
                  <Text style={[styles.scheduleHint, { color: colors.mutedForeground }]}>
                    {Platform.OS !== "web" ? "Pinch to zoom · scroll to explore" : "Scroll to explore"}
                  </Text>
                  <ScrollView
                    scrollEnabled
                    maximumZoomScale={4}
                    minimumZoomScale={1}
                    bouncesZoom={Platform.OS !== "web"}
                    showsVerticalScrollIndicator={false}
                    showsHorizontalScrollIndicator={false}
                    style={[styles.scheduleScroll, { borderColor: colors.border }]}
                    contentContainerStyle={styles.scheduleScrollContent}
                  >
                    <Image
                      source={{ uri: fullUrl }}
                      style={{ width: imageWidth, height: imageWidth * 1.4 }}
                      resizeMode="contain"
                    />
                  </ScrollView>
                </>
              );
            })()
          ) : (
            <>
              <Text style={[styles.scheduleWeek, { color: colors.mutedForeground }]}>
                Week of 4 – 10 May 2026
              </Text>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.dayPickerContent}
                style={styles.dayPicker}
              >
                {YOGA_DAYS.map((day, idx) => {
                  const active = selectedDay === idx;
                  return (
                    <Pressable
                      key={idx}
                      onPress={() => {
                        Haptics.selectionAsync().catch(() => {});
                        setSelectedDay(idx);
                      }}
                      style={[
                        styles.dayBtn,
                        active
                          ? { backgroundColor: colors.primary }
                          : { backgroundColor: colors.muted, borderColor: colors.border },
                      ]}
                    >
                      <Text style={[styles.dayBtnShort, { color: active ? colors.primaryForeground : colors.foreground }]}>
                        {day.short}
                      </Text>
                      <Text style={[styles.dayBtnDate, { color: active ? colors.primaryForeground + "BB" : colors.mutedForeground }]}>
                        {day.date}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <View style={[styles.slotList, { borderColor: colors.border }]}>
                {YOGA_SLOTS.filter((s) => s.sessions[selectedDay] !== "").map((slot, idx, arr) => {
                  const dotColor =
                    slot.kind === "yoga" ? colors.success :
                    slot.kind === "meal" ? colors.warning :
                    colors.primary;
                  return (
                    <View
                      key={idx}
                      style={[
                        styles.slotRow,
                        idx < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.border },
                      ]}
                    >
                      <View style={[styles.slotDot, { backgroundColor: dotColor }]} />
                      <View style={styles.slotContent}>
                        <Text style={[styles.slotTime, { color: colors.mutedForeground }]}>{slot.time}</Text>
                        <Text style={[styles.slotSession, { color: colors.foreground }]}>{slot.sessions[selectedDay]}</Text>
                        {slot.kind !== "meal" && (
                          <Text style={[styles.slotCategory, { color: colors.mutedForeground }]}>{slot.category}</Text>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      <Animated.View
        style={[
          styles.toast,
          { backgroundColor: toastBg, bottom: bottomPad + 100, opacity: toastOpacity },
        ]}
        testID="services-toast"
        pointerEvents="none"
      >
        <Feather
          name={toastType === "success" ? "check-circle" : "alert-circle"}
          size={16}
          color={toastFg}
        />
        <Text style={[styles.toastText, { color: toastFg }]}>{toastMessage}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
    gap: 2,
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
  content: {
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
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  cardHeaderEmoji: {
    fontSize: 22,
  },
  cardIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.3,
    flex: 1,
  },
  cardBody: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  divider: {
    height: 1,
  },
  faqRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 8,
  },
  faqQuestion: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    flex: 1,
    lineHeight: 20,
  },
  faqAnswer: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 19,
    paddingBottom: 10,
    paddingRight: 26,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
  actionBtnText: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    minHeight: 80,
  },
  infoBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  infoBannerText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    flex: 1,
  },
  scheduleHint: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: -4,
  },
  scheduleScroll: {
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  scheduleScrollContent: {
    alignItems: "center",
  },
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
  toastText: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    flex: 1,
    lineHeight: 18,
  },
  scheduleWeek: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    marginTop: -4,
  },
  dayPicker: {
    marginHorizontal: -4,
  },
  dayPickerContent: {
    paddingHorizontal: 4,
    gap: 6,
  },
  dayBtn: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: "center",
    minWidth: 54,
  },
  dayBtnShort: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
  dayBtnDate: {
    fontSize: 10,
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  slotList: {
    borderRadius: 12,
    borderWidth: 1,
    overflow: "hidden",
  },
  slotRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  slotDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 6,
    flexShrink: 0,
  },
  slotContent: {
    flex: 1,
    gap: 2,
  },
  slotTime: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.1,
  },
  slotSession: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    lineHeight: 18,
  },
  slotCategory: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
  },
});
