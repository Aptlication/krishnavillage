import { useState, useMemo } from "react";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  useGetHousekeepingReports,
  useAcknowledgeHousekeepingReport,
  useResolveHousekeepingReport,
  useCreateStaffHousekeepingReport,
  useGetGuests,
  getGetGuestsQueryKey,
  getGetHousekeepingReportsQueryKey,
  type HousekeepingReport as HousekeepingReportType,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import {
  Sparkles,
  CheckCircle2,
  Clock,
  User,
  PenLine,
  Plus,
  ArrowRight,
  ShieldCheck,
  AlertTriangle,
  Building2,
  Download,
  Paperclip,
  X,
  Loader2,
  FileText,
  MessageSquare,
} from "lucide-react";

type StatusFilter = "open" | "in_progress" | "resolved";
type DateRangeFilter = "today" | "this_week" | "all_time";
type ResolutionFilter = "all" | "actioned" | "delegated";

// ── Housekeeping personnel (assignable in Acknowledge / Sign Off) ────────────
const HOUSEKEEPING_STAFF = ["Sam", "HK 1", "HK 2", "HK 3", "HK 4"] as const;

interface HousekeepingReportItem {
  id: number;
  source: string;
  guestName: string;
  roomNumber: string;
  openedByName?: string | null;
  title: string;
  description: string;
  urgency: string;
  status: string;
  createdAt: string;
  inProgressAt?: string | null;
  inProgressByName?: string | null;
  inProgressNote?: string | null;
  resolution?: string | null;
  resolvedByName?: string | null;
  resolutionNote?: string | null;
  resolvedAt?: string | null;
  photos?: string[] | null;
  // Guest fields surfaced by the api-server so the Send SMS button can route
  // directly without an extra lookup. Optional because legacy rows / unlinked
  // guests may not have them populated.
  guestId?: number | null;
  guestMobile?: string | null;
  guestSurname?: string | null;
}

/**
 * Render a room label that respects the "type prefix" convention stored on
 * newly-created reports (e.g. "Cabin 4", "CAMP-001"). Legacy rows stored just
 * a bare number — those still display as "Room {n}" so existing data looks OK.
 */
function formatRoomLabel(roomNumber: string): string {
  if (/^\d+$/.test(roomNumber.trim())) return `Room ${roomNumber.trim()}`;
  return roomNumber;
}

/**
 * Pull the first non-whitespace token from a registered name. Reception enters
 * names inconsistently ("Sharma" vs "Anita Sharma") so we just take the first
 * word — matches what the server's deriveFirstName does.
 */
function deriveFirstName(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : fullName.trim();
}

/**
 * Status-aware starter message for the manual Send-SMS dialog. Staff can edit
 * it before sending — this is just a pre-fill so the textarea isn't empty.
 * Kept close to the server-side templates so the look is consistent, but
 * deliberately not identical: this path is for ad-hoc updates, not auto-fires.
 */
function renderHousekeepingStarter(args: {
  firstName: string;
  roomLabel: string;
  staffName: string;
  status: string;
}): string {
  const team = "Housekeeping";
  const by = args.staffName ? ` by ${args.staffName}` : "";
  if (args.status === "open") {
    return (
      `Hi ${args.firstName}, we've received your housekeeping request for ${args.roomLabel} ` +
      `and a member of ${team} will action it shortly. We'll keep you posted.`
    );
  }
  if (args.status === "in_progress") {
    return (
      `Hi ${args.firstName}, your housekeeping request for ${args.roomLabel} is in the pipeline ` +
      `and is being actioned${by} from ${team}. You will receive further confirmation of processing soon!`
    );
  }
  // resolved — handy for follow-ups even though auto-SMS already fired on sign-off
  return (
    `Hi ${args.firstName}, your housekeeping request for ${args.roomLabel} has been actioned${by} from ${team}.`
  );
}

function urgencyLabel(urgency: string) {
  return urgency === "urgent" ? "Urgent" : "Non-urgent";
}

function resolutionLabel(r: string | null | undefined) {
  if (r === "actioned") return "Actioned";
  if (r === "delegated") return "Delegated";
  return r ?? "";
}

export default function Housekeeping() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<StatusFilter>("open");

  // ── Create dialog ──────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [createRoom, setCreateRoom] = useState("");
  const [createRoomType, setCreateRoomType] = useState<"room" | "cabin">("room");
  const [createRoomNum, setCreateRoomNum] = useState("");
  // ── Guest section (Search existing → pre-fill / manual / skip) ────────────
  const [createGuestId, setCreateGuestId] = useState<number | null>(null);
  const [createGuestSurname, setCreateGuestSurname] = useState("");
  const [createGuestMobile, setCreateGuestMobile] = useState("");
  const [createGuestSearch, setCreateGuestSearch] = useState("");
  const [createGuestSkip, setCreateGuestSkip] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createUrgency, setCreateUrgency] = useState<"urgent" | "non_urgent">("non_urgent");
  const [createPhotos, setCreatePhotos] = useState<string[]>([]);
  const [createError, setCreateError] = useState("");

  // ── Acknowledge dialog ─────────────────────────────────────────────────────
  const [ackTarget, setAckTarget] = useState<HousekeepingReportItem | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [ackSignature, setAckSignature] = useState("");
  // ETA choice: numeric preset (sent as etaHours) or "Other" (sent as etaText).
  const [ackEtaChoice, setAckEtaChoice] = useState<string>("");
  const [ackEtaText, setAckEtaText] = useState<string>("");

  // ── Resolve dialog ─────────────────────────────────────────────────────────
  const [resolveTarget, setResolveTarget] = useState<HousekeepingReportItem | null>(null);
  const [resolveType, setResolveType] = useState<"actioned" | "delegated">("actioned");
  const [resolveNote, setResolveNote] = useState("");
  const [resolveSignature, setResolveSignature] = useState("");

  // Photo viewer
  const [photoViewerTarget, setPhotoViewerTarget] = useState<HousekeepingReportItem | null>(null);
  const [photoViewerIndex, setPhotoViewerIndex] = useState(0);

  // ── Manual Send-SMS dialog state ───────────────────────────────────────────
  // smsTarget holds the report we're composing an SMS for; smsBody is the
  // free-text message; smsError surfaces inline validation/server errors.
  // Carries enough context (status, mobile) for the dialog to show the
  // recipient number, choose the right starter template, and refuse to send
  // when no mobile is on file.
  const [smsTarget, setSmsTarget] = useState<{
    id: number;
    guestName: string;
    roomNumber: string;
    status: string;
    mobile: string | null;
    guestId: number | null;
  } | null>(null);
  const [smsBody, setSmsBody] = useState("");
  const [smsError, setSmsError] = useState<string | null>(null);

  // ── Resolved-tab filters ────────────────────────────────────────────────────
  const [dateRangeFilter, setDateRangeFilter] = useState<DateRangeFilter>("all_time");
  const [resolutionFilter, setResolutionFilter] = useState<ResolutionFilter>("all");
  const [resolvedSearchQuery, setResolvedSearchQuery] = useState("");

  // ── Export filters ──────────────────────────────────────────────────────────
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");
  const [exportResolution, setExportResolution] = useState<"all" | "actioned" | "delegated">("all");

  // ── Resolution-note expand/collapse ─────────────────────────────────────────
  const [expandedNotes, setExpandedNotes] = useState<Set<number>>(new Set());
  const RESOLUTION_NOTE_LIMIT = 160;
  function toggleNoteExpanded(id: number) {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ── Resolution-note inline editing ──────────────────────────────────────────
  const [editNoteTarget, setEditNoteTarget] = useState<number | null>(null);
  const [editNoteText, setEditNoteText] = useState("");

  // ── Escalate to urgent ──────────────────────────────────────────────────────
  const [escalateTarget, setEscalateTarget] = useState<HousekeepingReportItem | null>(null);

  const { data: reports, isLoading, isError } = useGetHousekeepingReports(
    { status: tab },
    {
      query: {
        enabled: !!session?.token,
        queryKey: getGetHousekeepingReportsQueryKey({ status: tab }),
        retry: false,
        refetchInterval: 30_000,
      },
    },
  );

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/housekeeping"] });
  };

  // ── Existing guests (for the Guest search picker in the create dialog) ────
  // We fetch all and filter client-side; the list is typically <50 active rows
  // so a remote search endpoint would be overkill.
  const { data: allGuests } = useGetGuests(
    {},
    {
      query: {
        enabled: !!session?.token && showCreate,
        queryKey: getGetGuestsQueryKey(),
        refetchInterval: 60_000,
      },
    },
  );
  const guestMatches = useMemo(() => {
    const q = createGuestSearch.trim().toLowerCase();
    if (!q) return [];
    return (allGuests ?? [])
      .filter((g) =>
        g.name.toLowerCase().includes(q) ||
        g.roomNumber.toLowerCase().includes(q) ||
        (g.mobile ?? "").toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [allGuests, createGuestSearch]);

  const createMutation = useCreateStaffHousekeepingReport({
    mutation: {
      onSuccess: () => {
        setShowCreate(false);
        setCreateRoom("");
        setCreateRoomType("room");
        setCreateRoomNum("");
        setCreateGuestId(null);
        setCreateGuestSurname("");
        setCreateGuestMobile("");
        setCreateGuestSearch("");
        setCreateGuestSkip(false);
        setCreateTitle("");
        setCreateDesc("");
        setCreateUrgency("non_urgent");
        setCreatePhotos([]);
        setCreateError("");
        invalidateAll();
      },
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; data?: { error?: string } };
        if (apiErr?.status === 401) return;
        setCreateError(apiErr?.data?.error ?? "Failed to create request. Please try again.");
      },
    },
  });

  const ackMutation = useAcknowledgeHousekeepingReport({
    mutation: {
      onSuccess: () => {
        setAckTarget(null);
        setAckNote("");
        setAckSignature("");
        setAckEtaChoice("");
        setAckEtaText("");
        invalidateAll();
      },
    },
  });

  const resolveMutation = useResolveHousekeepingReport({
    mutation: {
      onSuccess: () => {
        invalidateAll();
      },
    },
  });

  const updateNoteMutation = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string | null }) => {
      const res = await fetch(`/api/housekeeping/${id}/note`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: JSON.stringify({ resolutionNote: note }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to save note");
      }
      return res.json() as Promise<HousekeepingReportItem>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        getGetHousekeepingReportsQueryKey({ status: "resolved" }),
        (old: HousekeepingReportType[] | undefined) =>
          old?.map((r) => (r.id === updated.id ? { ...r, resolutionNote: updated.resolutionNote } : r)),
      );
      setEditNoteTarget(null);
      setEditNoteText("");
      toast({ title: "Note saved", description: "Resolution note has been updated." });
    },
    onError: (err: Error) => {
      toast({ title: "Could not save note", description: err.message, variant: "destructive" });
    },
  });


  // ── Manual SMS send + per-report SMS history ──────────────────────────────
  // We post directly to /api/sms/send rather than going through the codegen
  // hooks, mirroring the inline-fetch pattern used by updateNoteMutation. The
  // server requires either guestId (preferred — resolves mobile and links the
  // sms row to the guest) or `to` (raw E.164 for unlinked sends). We pass
  // guestId when the report has one, otherwise fall back to the mobile we
  // displayed in the dialog. linkedHousekeepingReportId is always set so the
  // audit trail appears on the right card.
  const sendSmsMutation = useMutation({
    mutationFn: async (args: { reportId: number; guestId: number | null; to: string | null; body: string }) => {
      const payload: Record<string, unknown> = {
        body: args.body,
        linkedHousekeepingReportId: args.reportId,
      };
      if (args.guestId !== null) payload["guestId"] = args.guestId;
      else if (args.to) payload["to"] = args.to;
      else throw new Error("No mobile on file and no linked guest — cannot send SMS.");

      const res = await fetch("/api/sms/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to send SMS");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "SMS queued for delivery" });
      setSmsTarget(null);
      setSmsBody("");
      setSmsError(null);
      queryClient.invalidateQueries({ queryKey: ["/api/sms/history"] });
    },
    onError: (err: Error) => {
      setSmsError(err.message);
    },
  });

  // Fetch all SMS rows linked to housekeeping reports so we can render audit-trail
  // lines on each card without per-card requests. Refresh is gentle; the page
  // is server-paginated anyway.
  const { data: smsHistoryRows } = useQuery({
    queryKey: ["/api/sms/history", "housekeeping"],
    enabled: !!session?.token,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Array<{
      id: number;
      to: string;
      body: string;
      status: string;
      trigger: string;
      sentByName: string | null;
      createdAt: string;
      linkedHousekeepingReportId: number | null;
    }>> => {
      const res = await fetch("/api/sms/history?limit=500", {
        headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
      });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Map of reportId → SMS rows linked to it (most recent first), used for the
  // per-card audit trail "📱 SMS sent at hh:mm" lines.
  const smsByReport = useMemo(() => {
    const map = new Map<number, Array<{ status: string; trigger: string; sentByName: string | null; createdAt: string }>>();
    smsHistoryRows?.forEach((row) => {
      const k = row.linkedHousekeepingReportId;
      if (!k) return;
      const arr = map.get(k) ?? [];
      arr.push({ status: row.status, trigger: row.trigger, sentByName: row.sentByName, createdAt: row.createdAt });
      map.set(k, arr);
    });
    return map;
  }, [smsHistoryRows]);

  const escalateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/housekeeping/${id}/urgency`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: JSON.stringify({ urgency: "urgent" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to escalate urgency");
      }
      return res.json() as Promise<HousekeepingReportItem>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        getGetHousekeepingReportsQueryKey({ status: tab }),
        (old: HousekeepingReportType[] | undefined) =>
          old?.map((r) => (r.id === updated.id ? { ...r, urgency: updated.urgency } : r)),
      );
      setEscalateTarget(null);
      toast({ title: "Escalated to urgent", description: "Housekeeping has been flagged urgent." });
    },
    onError: (err: Error) => {
      toast({ title: "Could not escalate", description: err.message, variant: "destructive" });
    },
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function resetResolveDialog() {
    setResolveTarget(null);
    setResolveNote("");
    setResolveType("actioned");
    setResolveSignature("");
  }

  function handleCreate() {
    if (!createRoomNum.trim() || !createTitle.trim() || !createDesc.trim()) {
      setCreateError("Please fill in all fields.");
      return;
    }
    setCreateError("");
    // Combine the type with the number so the stored roomNumber is self-describing
    // (e.g. "Cabin 4", "Room 12"). The UI helper formatRoomLabel renders it as-is.
    const combinedRoom =
      createRoomType === "cabin" ? `Cabin ${createRoomNum.trim()}` : `Room ${createRoomNum.trim()}`;
    createMutation.mutate({
      data: {
        roomNumber: combinedRoom,
        // Guest attribution — only send when the section wasn't skipped and
        // we have at least one field to record.
        ...(!createGuestSkip && createGuestId ? { guestId: createGuestId } : {}),
        ...(!createGuestSkip && createGuestSurname.trim() ? { guestSurname: createGuestSurname.trim() } : {}),
        ...(!createGuestSkip && createGuestMobile.trim() ? { guestMobile: createGuestMobile.trim() } : {}),
        title: createTitle.trim(),
        description: createDesc.trim(),
        urgency: createUrgency,
        ...(createPhotos.length > 0 ? { photos: createPhotos } : {}),
      } as Parameters<typeof createMutation.mutate>[0]["data"],
    });
  }

  function handleAck() {
    if (!ackTarget || !ackSignature.trim()) return;
    const sig = ackSignature.trim();
    const note = ackNote.trim();
    const fullNote = note ? `${note} [Acknowledged by: ${sig}]` : `Acknowledged by: ${sig}`;
    const etaHours =
      ackEtaChoice && ackEtaChoice !== "Other" ? parseInt(ackEtaChoice, 10) : null;
    const etaText =
      ackEtaChoice === "Other" && ackEtaText.trim() ? ackEtaText.trim() : null;
    ackMutation.mutate({
      id: ackTarget.id,
      data: {
        inProgressNote: fullNote,
        ...(etaHours ? { etaHours } : {}),
        ...(etaText ? { etaText } : {}),
      },
    });
  }

  async function handleResolve() {
    if (!resolveTarget || !resolveSignature.trim()) return;
    const fullNote = resolveNote.trim()
      ? `${resolveNote.trim()} [Signed: ${resolveSignature.trim()}]`
      : `Signed: ${resolveSignature.trim()}`;
    try {
      await resolveMutation.mutateAsync({
        id: resolveTarget.id,
        data: { resolution: resolveType, resolutionNote: fullNote },
      });
    } catch {
      return;
    }
    resetResolveDialog();
  }

  async function handleExport() {
    if (exportFrom && exportTo && exportFrom > exportTo) {
      toast({ title: "Invalid date range", description: "The 'from' date must be on or before the 'to' date.", variant: "destructive" });
      return;
    }
    const params = new URLSearchParams();
    if (exportFrom) params.set("from", exportFrom);
    if (exportTo) params.set("to", exportTo);
    if (exportResolution !== "all") params.set("resolution", exportResolution);
    const query = params.toString();
    const url = `/api/housekeeping/export${query ? `?${query}` : ""}`;
    const response = await fetch(url, {
      headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
    });
    if (!response.ok) {
      toast({ title: "Export failed", description: "Could not download the housekeeping report. Please try again.", variant: "destructive" });
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `housekeeping-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  }

  const tabCounts: Record<StatusFilter, number | undefined> = {
    open: tab === "open" ? reports?.length : undefined,
    in_progress: tab === "in_progress" ? reports?.length : undefined,
    resolved: tab === "resolved" ? reports?.length : undefined,
  };

  // ── Client-side filtering for the Resolved tab ──────────────────────────────
  const filteredReports = (reports as HousekeepingReportItem[] | undefined)?.filter((r) => {
    if (tab !== "resolved") return true;

    if (resolutionFilter !== "all" && r.resolution !== resolutionFilter) return false;

    if (dateRangeFilter !== "all_time") {
      if (!r.resolvedAt) return false;
      const resolvedDate = new Date(r.resolvedAt);
      const now = new Date();
      if (dateRangeFilter === "today") {
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (resolvedDate < startOfToday) return false;
      } else if (dateRangeFilter === "this_week") {
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1);
        const startOfWeek = new Date(now.getFullYear(), now.getMonth(), diff);
        startOfWeek.setHours(0, 0, 0, 0);
        if (resolvedDate < startOfWeek) return false;
      }
    }

    const q = resolvedSearchQuery.trim().toLowerCase();
    if (q) {
      const matchesGuest = r.guestName.toLowerCase().includes(q);
      const matchesRoom = r.roomNumber.toLowerCase().includes(q);
      const matchesTitle = r.title.toLowerCase().includes(q);
      if (!matchesGuest && !matchesRoom && !matchesTitle) return false;
    }

    return true;
  });

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Housekeeping</h1>
              <p className="text-sm text-muted-foreground">
                Housekeeping requests — open, action, and sign off
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {tab === "resolved" && (
              <div className="flex items-center gap-2 flex-wrap">
                <Input
                  type="date"
                  data-testid="export-from"
                  className="h-8 text-xs w-36"
                  value={exportFrom}
                  onChange={(e) => setExportFrom(e.target.value)}
                  title="Export from date"
                  aria-label="Export from date"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="date"
                  data-testid="export-to"
                  className="h-8 text-xs w-36"
                  value={exportTo}
                  onChange={(e) => setExportTo(e.target.value)}
                  title="Export to date"
                  aria-label="Export to date"
                />
                <Select
                  value={exportResolution}
                  onValueChange={(v) => setExportResolution(v as "all" | "actioned" | "delegated")}
                >
                  <SelectTrigger className="h-8 text-xs w-32" data-testid="export-resolution">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="actioned">Actioned</SelectItem>
                    <SelectItem value="delegated">Delegated</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={handleExport}>
                  <Download className="w-4 h-4 mr-1.5" />
                  Export CSV
                </Button>
              </div>
            )}
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4 mr-1.5" />
              New Request
            </Button>
          </div>
        </div>

        {/* Lifecycle guide */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-lg px-4 py-3 flex-wrap">
          <span className="font-medium text-foreground">Workflow:</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 rounded px-1.5 py-0.5 font-medium">
              <Clock className="w-3 h-3" /> Open
            </span>
          </span>
          <ArrowRight className="w-3 h-3" />
          <span className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 rounded px-1.5 py-0.5 font-medium">
              <Sparkles className="w-3 h-3" /> In Progress
            </span>
          </span>
          <ArrowRight className="w-3 h-3" />
          <span className="flex items-center gap-1.5">
            <span className="inline-flex items-center gap-1 bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 rounded px-1.5 py-0.5 font-medium">
              <ShieldCheck className="w-3 h-3" /> Resolved &amp; Signed Off
            </span>
          </span>
          <span className="ml-2 text-muted-foreground/70">
            · Staff must sign off every resolution with a note
          </span>
        </div>

        {/* Tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as StatusFilter)}>
          <TabsList>
            <TabsTrigger value="open" data-testid="tab-open">
              Open
              {tab === "open" && tabCounts.open !== undefined && tabCounts.open > 0 && (
                <span className="ml-1.5 bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {tabCounts.open}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="in_progress" data-testid="tab-in-progress">
              In Progress
              {tab === "in_progress" && tabCounts.in_progress !== undefined && tabCounts.in_progress > 0 && (
                <span className="ml-1.5 bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  {tabCounts.in_progress}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="resolved" data-testid="tab-resolved">
              Resolved
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Resolved-tab filter chips */}
        {tab === "resolved" && !isLoading && !isError && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              {(["today", "this_week", "all_time"] as DateRangeFilter[]).map((opt) => {
                const label = opt === "today" ? "Today" : opt === "this_week" ? "This week" : "All time";
                const active = dateRangeFilter === opt;
                return (
                  <button
                    key={opt}
                    onClick={() => setDateRangeFilter(opt)}
                    className={`text-xs px-3 py-1 rounded-full border font-medium transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="w-px h-5 bg-border" />

            <div className="flex items-center gap-1.5">
              {(["all", "actioned", "delegated"] as ResolutionFilter[]).map((opt) => {
                const label = opt === "all" ? "All" : opt === "actioned" ? "Actioned" : "Delegated";
                const active = resolutionFilter === opt;
                return (
                  <button
                    key={opt}
                    onClick={() => setResolutionFilter(opt)}
                    className={`text-xs px-3 py-1 rounded-full border font-medium transition-colors ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="w-px h-5 bg-border" />

            <div className="relative flex items-center">
              <User className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <Input
                data-testid="resolved-search-input"
                className="pl-8 pr-8 h-7 text-xs w-52"
                placeholder="Guest, room or title…"
                value={resolvedSearchQuery}
                onChange={(e) => setResolvedSearchQuery(e.target.value)}
              />
              {resolvedSearchQuery && (
                <button
                  onClick={() => setResolvedSearchQuery("")}
                  className="absolute right-2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}

        {isLoading && <div className="text-muted-foreground text-sm">Loading...</div>}
        {isError && (
          <div className="text-destructive text-sm">Failed to load housekeeping requests.</div>
        )}

        {!isLoading && !isError && filteredReports?.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-3">
            <CheckCircle2 className="w-10 h-10 opacity-30" />
            <p className="text-sm">
              {tab === "open"
                ? "No open housekeeping requests."
                : tab === "in_progress"
                ? "No requests currently in progress."
                : "No resolved housekeeping requests match the selected filters."}
            </p>
          </div>
        )}

        {/* Report cards */}
        <div className="space-y-3">
          {filteredReports?.map((report) => (
            <Card key={report.id} className="border border-border">
              <CardContent className="pt-5 pb-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    {/* Title row */}
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-semibold text-foreground truncate">{report.title}</span>
                      <Badge
                        variant={report.urgency === "urgent" ? "destructive" : "secondary"}
                        className="text-xs shrink-0"
                      >
                        {report.urgency === "urgent" && <AlertTriangle className="w-3 h-3 mr-1" />}
                        {urgencyLabel(report.urgency)}
                      </Badge>
                      {report.source === "staff" && (
                        <Badge variant="outline" className="text-xs shrink-0 text-blue-600 border-blue-300">
                          <Building2 className="w-3 h-3 mr-1" />
                          Staff raised
                        </Badge>
                      )}
                      {report.photos && report.photos.length > 0 && (
                        <Badge
                          variant="outline"
                          className="text-xs shrink-0 text-purple-700 border-purple-300 bg-purple-50 dark:bg-purple-950/30 dark:text-purple-400 dark:border-purple-700 cursor-pointer hover:bg-purple-100 dark:hover:bg-purple-950/50"
                          onClick={() => { setPhotoViewerTarget(report); setPhotoViewerIndex(0); }}
                          data-testid={`photos-badge-${report.id}`}
                        >
                          <Paperclip className="w-3 h-3 mr-1" />
                          {report.photos.length} {report.photos.length === 1 ? "photo" : "photos"}
                        </Badge>
                      )}
                      {report.resolutionNote && (
                        <Badge
                          variant="outline"
                          className="text-xs shrink-0 text-slate-600 border-slate-300 bg-slate-50 dark:bg-slate-900/30 dark:text-slate-400 dark:border-slate-600"
                        >
                          <FileText className="w-3 h-3 mr-1" />
                          Note
                        </Badge>
                      )}
                    </div>

                    {/* Meta */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2 flex-wrap">
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {report.source === "staff" ? (report.openedByName ?? report.guestName) : report.guestName}
                      </span>
                      <span>{formatRoomLabel(report.roomNumber)}</span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {format(new Date(report.createdAt), "d MMM yyyy, h:mm a")}
                      </span>
                    </div>

                    {/* Description */}
                    <p className="text-sm text-foreground/80 mb-3">{report.description}</p>

                    {/* Audit trail */}
                    {(report.inProgressByName || report.resolvedByName || smsByReport.get(report.id)?.length) && (
                      <div className="mt-2 pt-3 border-t border-border space-y-1.5">
                        {/* Per-report SMS audit lines — render every send (auto + manual). */}
                        {smsByReport.get(report.id)?.map((s, idx) => (
                          <p key={idx} className="text-xs text-muted-foreground flex items-start gap-1.5">
                            <MessageSquare className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                            <span>
                              {s.trigger === "auto_acknowledge" ? "Auto SMS (acknowledged)" : s.trigger === "auto_resolve" ? "Auto SMS (signed off)" : s.trigger === "manual" ? `SMS by ${s.sentByName ?? "staff"}` : "SMS broadcast"}
                              <span className="ml-1 text-muted-foreground/80">· {s.status.replace(/_/g, " ")}</span>
                              <span className="ml-1 text-muted-foreground/60">· {new Date(s.createdAt).toLocaleString()}</span>
                            </span>
                          </p>
                        ))}
                        {report.inProgressByName && (
                          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                            <Sparkles className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                            <span>
                              Acknowledged by{" "}
                              <span className="font-medium text-foreground">{report.inProgressByName}</span>
                              {report.inProgressAt && (
                                <span className="text-muted-foreground">
                                  {" "}· {format(new Date(report.inProgressAt), "d MMM yyyy, h:mm a")}
                                </span>
                              )}
                              {report.inProgressNote && (
                                <span className="text-muted-foreground"> — {report.inProgressNote}</span>
                              )}
                            </span>
                          </p>
                        )}
                        {report.resolvedByName && (
                          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />
                            <span>
                              Signed off by{" "}
                              <span className="font-medium text-foreground">{report.resolvedByName}</span>
                              {report.resolvedAt && (
                                <span className="text-muted-foreground">
                                  {" "}· {format(new Date(report.resolvedAt), "d MMM yyyy, h:mm a")}
                                </span>
                              )}
                              {report.resolution && (
                                <span className="ml-1">
                                  <Badge variant="outline" className="text-xs">
                                    {resolutionLabel(report.resolution)}
                                  </Badge>
                                </span>
                              )}
                            </span>
                          </p>
                        )}
                        {editNoteTarget === report.id ? (
                          <div className="space-y-2">
                            <Textarea
                              value={editNoteText}
                              onChange={(e) => setEditNoteText(e.target.value)}
                              placeholder="Add a resolution note…"
                              rows={3}
                              maxLength={1000}
                              className="text-xs"
                              autoFocus
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                disabled={updateNoteMutation.isPending}
                                onClick={() =>
                                  updateNoteMutation.mutate({
                                    id: report.id,
                                    note: editNoteText.trim() || null,
                                  })
                                }
                              >
                                {updateNoteMutation.isPending ? (
                                  <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Saving…</>
                                ) : (
                                  "Save note"
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={updateNoteMutation.isPending}
                                onClick={() => { setEditNoteTarget(null); setEditNoteText(""); }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : report.resolutionNote ? (
                          <div className="flex items-start gap-1.5 rounded-md border bg-muted px-2.5 py-1.5">
                            <PenLine className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                            <span className="text-xs text-muted-foreground leading-snug">
                              {report.resolutionNote.length > RESOLUTION_NOTE_LIMIT && !expandedNotes.has(report.id)
                                ? report.resolutionNote.slice(0, RESOLUTION_NOTE_LIMIT).trimEnd() + "…"
                                : report.resolutionNote}
                              {report.resolutionNote.length > RESOLUTION_NOTE_LIMIT && (
                                <button
                                  onClick={() => toggleNoteExpanded(report.id)}
                                  className="ml-1 text-xs font-medium text-primary hover:underline focus:outline-none"
                                >
                                  {expandedNotes.has(report.id) ? "Show less" : "Show more"}
                                </button>
                              )}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col gap-2 shrink-0">
                    {report.status === "open" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-blue-600 border-blue-200 hover:bg-blue-50"
                        onClick={() => { setAckTarget(report); setAckNote(""); }}
                      >
                        <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                        Acknowledge
                      </Button>
                    )}
                    {report.status === "in_progress" && (
                      <Button
                        size="sm"
                        className="bg-green-600 hover:bg-green-700 text-white"
                        onClick={() => { setResolveTarget(report); setResolveNote(""); setResolveType("actioned"); }}
                      >
                        <ShieldCheck className="w-3.5 h-3.5 mr-1.5" />
                        Sign Off
                      </Button>
                    )}
                    {report.urgency !== "urgent" && report.status !== "resolved" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-orange-600 border-orange-200 hover:bg-orange-50"
                        onClick={() => setEscalateTarget(report)}
                      >
                        <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />
                        Escalate
                      </Button>
                    )}
                    {report.status === "resolved" && editNoteTarget !== report.id && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="edit-note-btn"
                        onClick={() => {
                          setEditNoteTarget(report.id);
                          setEditNoteText(report.resolutionNote ?? "");
                        }}
                      >
                        <PenLine className="w-3.5 h-3.5 mr-1.5" />
                        {report.resolutionNote ? "Edit note" : "Add note"}
                      </Button>
                    )}

                    {/* Send SMS — opens the manual dialog with a status-aware
                        starter template pre-filled. Disabled when no mobile is
                        on file; the tooltip explains why. */}
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="send-sms-btn"
                      className="text-emerald-700 border-emerald-200 hover:bg-emerald-50 disabled:opacity-50"
                      disabled={!report.guestMobile}
                      title={!report.guestMobile ? "No mobile on file for this guest" : "Send a custom SMS to the guest"}
                      onClick={() => {
                        const firstName = deriveFirstName(report.guestName);
                        const roomLabel = formatRoomLabel(report.roomNumber);
                        const staffName =
                          report.resolvedByName ?? report.inProgressByName ?? "";
                        setSmsTarget({
                          id: report.id,
                          guestName: report.guestName,
                          roomNumber: report.roomNumber,
                          status: report.status,
                          mobile: report.guestMobile ?? null,
                          guestId: report.guestId ?? null,
                        });
                        setSmsBody(
                          renderHousekeepingStarter({
                            firstName,
                            roomLabel,
                            staffName,
                            status: report.status,
                          }),
                        );
                        setSmsError(null);
                      }}
                    >
                      <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                      Send SMS
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* ── Create Request dialog ─────────────────────────────────────────── */}
      <Dialog open={showCreate} onOpenChange={(o) => { setShowCreate(o); setCreateError(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Housekeeping Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Housekeeping requests are tracked through the same Open → In Progress → Resolved pipeline as maintenance and require sign-off before closing.
            </p>
            <div className="space-y-1.5">
              <Label>Accommodation type</Label>
              <div className="grid grid-cols-2 gap-2">
                {(["room", "cabin"] as const).map((t) => (
                  <Button
                    key={t}
                    type="button"
                    variant={createRoomType === t ? "default" : "outline"}
                    onClick={() => setCreateRoomType(t)}
                    size="sm"
                  >
                    {t === "room" ? "Room" : "Cabin"}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{createRoomType === "cabin" ? "Cabin number" : "Room number"}</Label>
              <Input
                placeholder={createRoomType === "cabin" ? "e.g. 4" : "e.g. 12"}
                value={createRoomNum}
                onChange={(e) => setCreateRoomNum(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Issue title</Label>
              <Input
                placeholder="e.g. Full clean after checkout"
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Details</Label>
              <Textarea
                placeholder="Describe what needs cleaning and any special notes"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                rows={3}
                maxLength={500}
              />
            </div>
            {/* ── Photos (optional, up to 5) ──────────────────────────── */}
            <div className="space-y-1.5">
              <Label>Photos <span className="text-muted-foreground font-normal text-xs">(optional, up to 5)</span></Label>
              <div className="flex flex-wrap gap-2 items-center">
                {createPhotos.map((src, idx) => (
                  <div key={idx} className="relative">
                    <img src={src} alt={`Photo ${idx + 1}`} className="w-16 h-16 object-cover rounded border" />
                    <button
                      type="button"
                      onClick={() => setCreatePhotos((prev) => prev.filter((_, i) => i !== idx))}
                      className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-destructive/90"
                      aria-label={`Remove photo ${idx + 1}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
                {createPhotos.length < 5 && (
                  <label className="w-16 h-16 border-2 border-dashed border-border rounded flex flex-col items-center justify-center cursor-pointer hover:bg-muted/50 text-muted-foreground">
                    <Paperclip className="w-4 h-4" />
                    <span className="text-[10px] mt-0.5">Add</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length === 0) return;
                        const remaining = 5 - createPhotos.length;
                        const toRead = files.slice(0, remaining);
                        toRead.forEach((file) => {
                          if (file.size > 5 * 1024 * 1024) {
                            setCreateError(`"${file.name}" is too large (max 5 MB). Try a smaller image.`);
                            return;
                          }
                          const reader = new FileReader();
                          reader.onload = () => {
                            const result = reader.result;
                            if (typeof result === "string") {
                              setCreatePhotos((prev) => (prev.length >= 5 ? prev : [...prev, result]));
                            }
                          };
                          reader.readAsDataURL(file);
                        });
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Urgency</Label>
              <Select value={createUrgency} onValueChange={(v) => setCreateUrgency(v as "urgent" | "non_urgent")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="non_urgent">Non-urgent — attend when convenient</SelectItem>
                  <SelectItem value="urgent">Urgent — needs immediate attention</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* ── Guest section ─────────────────────────────────────────── */}
            <div className="space-y-2 p-3 rounded-md border bg-muted/30">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Guest (for SMS notifications)</Label>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline"
                  onClick={() => {
                    setCreateGuestSkip(!createGuestSkip);
                    if (!createGuestSkip) {
                      setCreateGuestId(null);
                      setCreateGuestSurname("");
                      setCreateGuestMobile("");
                      setCreateGuestSearch("");
                    }
                  }}
                >
                  {createGuestSkip ? "Add guest details" : "Skip"}
                </button>
              </div>
              {!createGuestSkip && (
                <>
                  {!createGuestId && (
                    <div className="relative">
                      <Input
                        placeholder="Search existing guests by name, room or mobile…"
                        value={createGuestSearch}
                        onChange={(e) => setCreateGuestSearch(e.target.value)}
                        className="text-sm"
                      />
                      {guestMatches.length > 0 && (
                        <div className="absolute z-10 left-0 right-0 mt-1 bg-popover border rounded-md shadow-md max-h-56 overflow-y-auto">
                          {guestMatches.map((g) => (
                            <button
                              key={g.id}
                              type="button"
                              className="w-full text-left px-3 py-2 hover:bg-accent text-sm flex flex-col"
                              onClick={() => {
                                setCreateGuestId(g.id);
                                setCreateGuestSurname(g.name);
                                setCreateGuestMobile(g.mobile ?? "");
                                setCreateGuestSearch("");
                              }}
                            >
                              <span className="font-medium">{g.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {g.roomNumber} {g.mobile ? `· ${g.mobile}` : "· no mobile on file"}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {createGuestId && (
                    <div className="flex items-center justify-between gap-2 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 rounded px-2.5 py-1.5">
                      <span className="text-xs">
                        Linked to <span className="font-semibold">{createGuestSurname || "guest"}</span>
                        {createGuestMobile && <span className="text-muted-foreground"> · {createGuestMobile}</span>}
                      </span>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground underline"
                        onClick={() => { setCreateGuestId(null); }}
                      >
                        Unlink
                      </button>
                    </div>
                  )}
                  {createGuestId && !createGuestMobile.trim() && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      ⚠ This guest has no mobile on file — auto-SMS will be skipped unless you enter one below.
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Surname</Label>
                      <Input
                        placeholder="Sharma"
                        value={createGuestSurname}
                        onChange={(e) => setCreateGuestSurname(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Mobile</Label>
                      <Input
                        placeholder="0412 345 678"
                        value={createGuestMobile}
                        onChange={(e) => setCreateGuestMobile(e.target.value)}
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
            {createError && (
              <p className="text-sm text-destructive">{createError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreate(false); setCreatePhotos([]); }}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Submitting…" : "Submit Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Escalate to Urgent dialog ─────────────────────────────────────── */}
      <Dialog open={!!escalateTarget} onOpenChange={(o) => { if (!o) setEscalateTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-500" /> Escalate to Urgent
            </DialogTitle>
          </DialogHeader>
          {escalateTarget && (
            <div className="space-y-4 py-2">
              <div className="bg-muted rounded-lg p-3 text-sm">
                <p className="font-semibold">{escalateTarget.title}</p>
                <p className="text-muted-foreground mt-0.5">{formatRoomLabel(escalateTarget.roomNumber)} · {escalateTarget.guestName}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                This will mark the housekeeping report as <strong>Urgent</strong>.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEscalateTarget(null)}>Cancel</Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              disabled={escalateMutation.isPending}
              onClick={() => escalateTarget && escalateMutation.mutate(escalateTarget.id)}
            >
              {escalateMutation.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Escalating…</>
              ) : (
                <><AlertTriangle className="w-3.5 h-3.5 mr-1.5" />Escalate to Urgent</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Acknowledge dialog ────────────────────────────────────────────── */}
      <Dialog open={!!ackTarget} onOpenChange={(o) => { if (!o) { setAckTarget(null); setAckNote(""); setAckSignature(""); setAckEtaChoice(""); setAckEtaText(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-500" /> Acknowledge Report
            </DialogTitle>
          </DialogHeader>
          {ackTarget && (
            <div className="space-y-4 py-2">
              <div className="bg-muted rounded-lg p-3 text-sm">
                <p className="font-semibold">{ackTarget.title}</p>
                <p className="text-muted-foreground mt-0.5">{formatRoomLabel(ackTarget.roomNumber)} · {ackTarget.guestName}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Acknowledging moves this report to <strong>In Progress</strong>. Select the housekeeping member it's assigned to and add a note with any initial instructions.
              </p>
              <div className="space-y-1.5">
                <Label>
                  Assigned to <span className="text-destructive">*</span>
                </Label>
                <Select value={ackSignature} onValueChange={setAckSignature}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select housekeeping member…" />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUSEKEEPING_STAFF.map((name) => (
                      <SelectItem key={name} value={name}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Note (optional)</Label>
                <Textarea
                  placeholder="e.g. Full clean before tomorrow's check-in"
                  value={ackNote}
                  onChange={(e) => setAckNote(e.target.value)}
                  rows={3}
                  maxLength={300}
                />
              </div>
              <div className="space-y-1.5">
                <Label>
                  ETA <span className="text-muted-foreground font-normal">(estimate only — communicated to guest)</span>
                </Label>
                <Select value={ackEtaChoice} onValueChange={setAckEtaChoice}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick an estimated time…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Within 1 hour</SelectItem>
                    <SelectItem value="2">Within 2 hours</SelectItem>
                    <SelectItem value="4">Within 4 hours</SelectItem>
                    <SelectItem value="24">Within 24 hours</SelectItem>
                    <SelectItem value="48">Within 48 hours</SelectItem>
                    <SelectItem value="Other">Other (free text)</SelectItem>
                  </SelectContent>
                </Select>
                {ackEtaChoice === "Other" && (
                  <Input
                    placeholder="e.g. by tomorrow morning"
                    value={ackEtaText}
                    onChange={(e) => setAckEtaText(e.target.value)}
                    maxLength={80}
                    className="mt-2"
                  />
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAckTarget(null)}>Cancel</Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={handleAck}
              disabled={ackMutation.isPending || !ackSignature.trim()}
              title={!ackSignature.trim() ? "Select a housekeeping member to acknowledge" : undefined}
            >
              {ackMutation.isPending ? "Saving…" : "Mark In Progress"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Resolve / Sign-Off dialog ─────────────────────────────────────── */}
      <Dialog
        open={!!resolveTarget}
        onOpenChange={(o) => { if (!o && !resolveMutation.isPending) resetResolveDialog(); }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-green-600" /> Sign Off &amp; Resolve
            </DialogTitle>
          </DialogHeader>
          {resolveTarget && (
            <div className="space-y-4 py-2">
              <div className="bg-muted rounded-lg p-3 text-sm">
                <p className="font-semibold">{resolveTarget.title}</p>
                <p className="text-muted-foreground mt-0.5">{formatRoomLabel(resolveTarget.roomNumber)} · {resolveTarget.guestName}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Provide a resolution type and a brief note confirming the work is complete. This creates a permanent audit record.
              </p>

              {/* Resolution type */}
              <div className="space-y-1.5">
                <Label>Resolution type</Label>
                <Select value={resolveType} onValueChange={(v) => setResolveType(v as "actioned" | "delegated")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="actioned">Actioned — completed by housekeeping</SelectItem>
                    <SelectItem value="delegated">Delegated — referred to contractor or owner</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Sign-off name */}
              <div className="space-y-1.5">
                <Label>
                  Signing off as <span className="text-destructive">*</span>
                </Label>
                <Select value={resolveSignature} onValueChange={setResolveSignature}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select housekeeping member…" />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUSEKEEPING_STAFF.map((name) => (
                      <SelectItem key={name} value={name}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  By selecting your name you confirm this report has been actioned correctly and you take responsibility for the sign-off.
                </p>
              </div>

              {/* Sign-off note */}
              <div className="space-y-1.5">
                <Label>Sign-off note <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Textarea
                  placeholder="e.g. Room fully cleaned, linen replaced, bathroom restocked."
                  value={resolveNote}
                  onChange={(e) => setResolveNote(e.target.value)}
                  rows={3}
                  maxLength={500}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={resetResolveDialog} disabled={resolveMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={handleResolve}
              disabled={resolveMutation.isPending || !resolveSignature.trim()}
              title={!resolveSignature.trim() ? "Select your name to confirm sign-off" : undefined}
            >
              {resolveMutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Confirm Sign Off"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Photo viewer dialog ─────────────────────────────────────────── */}
      <Dialog
        open={!!photoViewerTarget}
        onOpenChange={(o) => { if (!o) { setPhotoViewerTarget(null); setPhotoViewerIndex(0); } }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {photoViewerTarget?.title ?? "Photos"}
              {photoViewerTarget?.photos && photoViewerTarget.photos.length > 1 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  {photoViewerIndex + 1} of {photoViewerTarget.photos.length}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {photoViewerTarget?.photos && photoViewerTarget.photos.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-center bg-muted rounded-md overflow-hidden" style={{ minHeight: 300 }}>
                <img
                  src={photoViewerTarget.photos[photoViewerIndex]}
                  alt={`Housekeeping photo ${photoViewerIndex + 1}`}
                  className="max-h-[70vh] max-w-full object-contain"
                />
              </div>
              {photoViewerTarget.photos.length > 1 && (
                <div className="flex items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPhotoViewerIndex((i) => Math.max(0, i - 1))}
                    disabled={photoViewerIndex === 0}
                  >
                    ← Previous
                  </Button>
                  <div className="flex gap-1.5 flex-wrap justify-center">
                    {photoViewerTarget.photos.map((p, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setPhotoViewerIndex(i)}
                        className={`border-2 rounded ${i === photoViewerIndex ? "border-primary" : "border-transparent opacity-60 hover:opacity-100"}`}
                      >
                        <img src={p} alt={`Thumb ${i + 1}`} className="w-14 h-14 object-cover rounded" />
                      </button>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPhotoViewerIndex((i) => Math.min(photoViewerTarget!.photos!.length - 1, i + 1))}
                    disabled={photoViewerIndex >= photoViewerTarget.photos.length - 1}
                  >
                    Next →
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {" · "}{photoViewerTarget.createdAt && new Date(photoViewerTarget.createdAt).toLocaleString()}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                const photo = photoViewerTarget?.photos?.[photoViewerIndex];
                if (!photo) return;
                const a = document.createElement("a");
                a.href = photo;
                a.download = `housekeeping-${photoViewerTarget?.id}-photo-${photoViewerIndex + 1}.jpg`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }}
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Download
            </Button>
            <Button onClick={() => { setPhotoViewerTarget(null); setPhotoViewerIndex(0); }}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Manual Send-SMS dialog ───────────────────────────────────────── */}
      <Dialog open={!!smsTarget} onOpenChange={(o) => { if (!o) { setSmsTarget(null); setSmsBody(""); setSmsError(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-emerald-600" /> Send SMS to guest
            </DialogTitle>
          </DialogHeader>
          {smsTarget && (
            <div className="space-y-4 py-2">
              <div className="bg-muted rounded-lg p-3 text-sm">
                <p className="font-semibold">{smsTarget.guestName}</p>
                <p className="text-muted-foreground mt-0.5">{formatRoomLabel(smsTarget.roomNumber)}</p>
                <p className="text-muted-foreground mt-0.5 font-mono text-xs">
                  {smsTarget.mobile ?? "no mobile on file"}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                The tenant footer is appended automatically. Avoid disclosing private info — SMS is
                not encrypted in transit.
              </p>
              <div className="space-y-1.5">
                <Label>Message</Label>
                <Textarea
                  placeholder="e.g. Your room has been cleaned and is ready for you."
                  value={smsBody}
                  onChange={(e) => setSmsBody(e.target.value)}
                  rows={5}
                  maxLength={500}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  {smsBody.length} / 500 characters (~{Math.ceil((smsBody.length + 80) / 153)} SMS segments incl. footer)
                </p>
              </div>
              {smsError && <p className="text-sm text-destructive">{smsError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setSmsTarget(null); setSmsBody(""); setSmsError(null); }} disabled={sendSmsMutation.isPending}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              onClick={() => {
                if (!smsTarget) return;
                if (!smsBody.trim()) { setSmsError("Message body is required."); return; }
                sendSmsMutation.mutate({
                  reportId: smsTarget.id,
                  guestId: smsTarget.guestId,
                  to: smsTarget.mobile,
                  body: smsBody.trim(),
                });
              }}
              disabled={sendSmsMutation.isPending || !smsBody.trim()}
            >
              {sendSmsMutation.isPending ? "Sending…" : "Send SMS"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
