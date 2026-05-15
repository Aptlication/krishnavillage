import { useState, useMemo, useRef } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  useGetMaintenanceReports,
  useAcknowledgeMaintenanceReport,
  useResolveMaintenanceReport,
  useCreateStaffMaintenanceReport,
  useUploadExpenseReceipt,
  useCreateExpenseClaim,
  useGetExpenseBadges,
  getGetExpenseBadgesQueryKey,
  getGetMaintenanceReportsQueryKey,
  MaintenanceReportUrgency,
  type ExpenseBadge,
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
  Wrench,
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
  DollarSign,
  Paperclip,
  X,
  ChevronDown,
  ChevronUp,
  Receipt,
  Loader2,
  FileText,
} from "lucide-react";

type StatusFilter = "open" | "in_progress" | "resolved";
type DateRangeFilter = "today" | "this_week" | "all_time";
type ResolutionFilter = "all" | "actioned" | "delegated";

interface MaintenanceReportItem {
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
}

interface ReceiptFile {
  id: string;
  name: string;
  url: string;
  uploading: boolean;
}

function urgencyLabel(urgency: string) {
  return urgency === "urgent" ? "Urgent" : "Non-urgent";
}

function resolutionLabel(r: string | null | undefined) {
  if (r === "actioned") return "Actioned";
  if (r === "delegated") return "Delegated";
  return r ?? "";
}

export default function Maintenance() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<StatusFilter>("open");

  // ── Create dialog ──────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [createRoom, setCreateRoom] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createUrgency, setCreateUrgency] = useState<"urgent" | "non_urgent">("non_urgent");
  const [createPhotos, setCreatePhotos] = useState<string[]>([]);
  const [createError, setCreateError] = useState("");

  // ── Acknowledge dialog ─────────────────────────────────────────────────────
  const [ackTarget, setAckTarget] = useState<MaintenanceReportItem | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [ackSignature, setAckSignature] = useState("");

  // ── Resolve dialog ─────────────────────────────────────────────────────────
  const [resolveTarget, setResolveTarget] = useState<MaintenanceReportItem | null>(null);
  const [resolveType, setResolveType] = useState<"actioned" | "delegated">("actioned");
  const [resolveNote, setResolveNote] = useState("");
  const [resolveSignature, setResolveSignature] = useState("");

  // Photo viewer (guest-uploaded maintenance photos)
  const [photoViewerTarget, setPhotoViewerTarget] = useState<MaintenanceReportItem | null>(null);
  const [photoViewerIndex, setPhotoViewerIndex] = useState(0);

  // ── Expense claim section (within resolve dialog) ──────────────────────────
  const [showExpenseSection, setShowExpenseSection] = useState(false);
  const [expenseDesc, setExpenseDesc] = useState("");
  const [expenseProject, setExpenseProject] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [receiptFiles, setReceiptFiles] = useState<ReceiptFile[]>([]);
  const [expenseError, setExpenseError] = useState<string | null>(null);
  const [isSubmittingExpense, setIsSubmittingExpense] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  const [escalateTarget, setEscalateTarget] = useState<MaintenanceReportItem | null>(null);

  const { data: reports, isLoading, isError } = useGetMaintenanceReports(
    { status: tab },
    {
      query: {
        enabled: !!session?.token,
        queryKey: getGetMaintenanceReportsQueryKey({ status: tab }),
        retry: false,
        refetchInterval: 30_000,
      },
    },
  );

  // Build a comma-separated list of all resolved report IDs so we can fetch
  // their linked expenses in a single query using the maintenanceReportIds param,
  // which bypasses the staff-scope filter — any tenant staff sees the badges.
  const resolvedReportIdsCsv = useMemo(() => {
    if (tab !== "resolved" || !reports) return "";
    return (reports as MaintenanceReportItem[]).map((r) => r.id).join(",");
  }, [tab, reports]);

  // Fetch minimal badge data for all resolved reports in a single query.
  // Uses GET /api/expenses/badges — returns only maintenanceReportId, amountAud,
  // description, project. No staffEmail or receiptUrls, accessible to any tenant staff.
  const { data: expenseBadges } = useGetExpenseBadges(
    { maintenanceReportIds: resolvedReportIdsCsv },
    {
      query: {
        enabled: tab === "resolved" && !!session?.token && resolvedReportIdsCsv.length > 0,
        queryKey: getGetExpenseBadgesQueryKey({ maintenanceReportIds: resolvedReportIdsCsv }),
        refetchInterval: 60_000,
      },
    },
  );

  // Map maintenanceReportId → ExpenseBadge for O(1) card lookups
  const expenseByReport = useMemo(() => {
    const map = new Map<number, ExpenseBadge>();
    expenseBadges?.forEach((b) => {
      map.set(b.maintenanceReportId, b);
    });
    return map;
  }, [expenseBadges]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/maintenance"] });
  };

  const createMutation = useCreateStaffMaintenanceReport({
    mutation: {
      onSuccess: () => {
        setShowCreate(false);
        setCreateRoom("");
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

  const ackMutation = useAcknowledgeMaintenanceReport({
    mutation: {
      onSuccess: () => {
        setAckTarget(null);
        setAckNote("");
        setAckSignature("");
        invalidateAll();
      },
    },
  });

  const resolveMutation = useResolveMaintenanceReport({
    mutation: {
      onSuccess: () => {
        invalidateAll();
      },
    },
  });

  const uploadReceiptMutation = useUploadExpenseReceipt();
  const createExpenseMutation = useCreateExpenseClaim();

  const updateNoteMutation = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string | null }) => {
      const res = await fetch(`/api/maintenance/${id}/note`, {
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
      return res.json() as Promise<MaintenanceReportItem>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        getGetMaintenanceReportsQueryKey({ status: "resolved" }),
        (old: MaintenanceReportItem[] | undefined) =>
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

  const escalateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/maintenance/${id}/urgency`, {
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
      return res.json() as Promise<MaintenanceReportItem>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        getGetMaintenanceReportsQueryKey({ status: tab }),
        (old: MaintenanceReportItem[] | undefined) =>
          old?.map((r) => (r.id === updated.id ? { ...r, urgency: updated.urgency } : r)),
      );
      setEscalateTarget(null);
      toast({ title: "Escalated to urgent", description: "Staff have been notified." });
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
    setShowExpenseSection(false);
    setExpenseDesc("");
    setExpenseProject("");
    setExpenseAmount("");
    setReceiptFiles([]);
    setExpenseError(null);
    setIsSubmittingExpense(false);
  }

  function handleCreate() {
    if (!createRoom.trim() || !createTitle.trim() || !createDesc.trim()) {
      setCreateError("Please fill in all fields.");
      return;
    }
    setCreateError("");
    createMutation.mutate({
      // The generated type for `data` doesn't yet declare `photos`; the server
      // accepts and stores it. Cast is intentional until OpenAPI is regenerated.
      data: {
        roomNumber: createRoom.trim(),
        title: createTitle.trim(),
        description: createDesc.trim(),
        urgency: createUrgency as MaintenanceReportUrgency,
        ...(createPhotos.length > 0 ? { photos: createPhotos } : {}),
      } as Parameters<typeof createMutation.mutate>[0]["data"],
    });
  }

  function handleAck() {
    if (!ackTarget || !ackSignature.trim()) return;
    const sig = ackSignature.trim();
    const note = ackNote.trim();
    const fullNote = note ? `${note} [Acknowledged by: ${sig}]` : `Acknowledged by: ${sig}`;
    ackMutation.mutate({ id: ackTarget.id, data: { inProgressNote: fullNote } });
  }

  async function handleResolve() {
    if (!resolveTarget || !resolveSignature.trim()) return;

    setExpenseError(null);

    // ── Snapshot all form state into locals BEFORE any await ──────────────────
    // This prevents a race condition where the dialog is dismissed during the
    // async resolve, which would call resetResolveDialog() and wipe the expense
    // fields before the expense POST runs.
    const snapshotShowExpense = showExpenseSection;
    const snapshotDesc = expenseDesc.trim();
    const snapshotProject = expenseProject.trim();
    const snapshotAmountRaw = expenseAmount.trim();
    const snapshotFiles = receiptFiles.slice(); // shallow copy
    const snapshotReportId = resolveTarget.id;
    const snapshotSig = resolveSignature.trim();
    const snapshotNote = resolveNote.trim();
    const snapshotType = resolveType;

    // ── Validate expense fields (client-side, no network calls) ───────────────
    // An uploaded receipt is treated as "expense intent" — if receipts have been
    // attached, description + amount are required to avoid silently discarding data.
    let shouldCreateExpense = false;
    let parsedAmount = 0;
    const snapshotUploadedUrls = snapshotFiles
      .filter((f) => !f.uploading && f.url)
      .map((f) => f.url);
    const hasAnyExpenseSignal =
      snapshotShowExpense &&
      (snapshotDesc.length > 0 ||
        snapshotAmountRaw.length > 0 ||
        snapshotProject.length > 0 ||
        snapshotUploadedUrls.length > 0);
    if (hasAnyExpenseSignal) {
      if (!snapshotDesc) {
        setExpenseError("Please enter an expense description.");
        return;
      }
      parsedAmount = parseFloat(snapshotAmountRaw.replace(",", "."));
      if (!snapshotAmountRaw || isNaN(parsedAmount) || parsedAmount <= 0) {
        setExpenseError("Please enter a valid amount greater than zero.");
        return;
      }
      shouldCreateExpense = true;
    }

    // ── Step 1: Resolve the maintenance report FIRST ──────────────────────────
    // Resolving is idempotent (the report moves to resolved once). Doing this
    // first means that if the expense POST subsequently fails, no retry can
    // accidentally create a duplicate expense claim — the resolve PATCH will
    // 409/no-op and the user won't be prompted to resubmit the expense.
    const fullNote = snapshotNote
      ? `${snapshotNote} [Signed: ${snapshotSig}]`
      : `Signed: ${snapshotSig}`;
    try {
      await resolveMutation.mutateAsync({
        id: snapshotReportId,
        data: { resolution: snapshotType, resolutionNote: fullNote },
      });
    } catch {
      // resolveMutation.isError handles error UI; keep dialog open so staff
      // can retry the sign-off without losing their entered data.
      return;
    }

    // ── Step 2: Create expense claim (after resolution confirmed) ─────────────
    // If this fails, surface it as a toast (the dialog is about to close) so
    // staff know to submit the claim separately from the Expenses page.
    if (shouldCreateExpense) {
      setIsSubmittingExpense(true);
      try {
        await createExpenseMutation.mutateAsync({
          data: {
            claimDate: new Date().toISOString().slice(0, 10),
            description: snapshotDesc,
            project: snapshotProject || null,
            amountAud: parsedAmount.toFixed(2),
            receiptUrls: snapshotFiles
              .filter((f) => !f.uploading && f.url)
              .map((f) => f.url),
            maintenanceReportId: snapshotReportId,
          },
        });
        queryClient.invalidateQueries({ queryKey: ["/api/expenses/badges"] });
      } catch (err: unknown) {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        toast({
          title: "Sign-off recorded — expense not saved",
          description: msg
            ? `${msg} Please submit the expense from the Expenses page.`
            : "The maintenance report was resolved, but the expense claim could not be saved. Please submit the claim separately from the Expenses page.",
          variant: "destructive",
        });
      } finally {
        setIsSubmittingExpense(false);
      }
    }

    // ── Close dialog ──────────────────────────────────────────────────────────
    // Always close after resolution succeeds, regardless of expense outcome.
    resetResolveDialog();
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    for (const file of files) {
      const id = Math.random().toString(36).slice(2);
      setReceiptFiles((prev) => [...prev, { id, name: file.name, url: "", uploading: true }]);
      try {
        const result = await uploadReceiptMutation.mutateAsync({ data: { file } });
        setReceiptFiles((prev) =>
          prev.map((f) => (f.id === id ? { ...f, url: result.url, uploading: false } : f))
        );
      } catch {
        setReceiptFiles((prev) => prev.filter((f) => f.id !== id));
        toast({
          title: "Upload failed",
          description: `Could not upload ${file.name}. Please try again.`,
          variant: "destructive",
        });
      }
    }
  }

  function removeReceipt(id: string) {
    setReceiptFiles((prev) => prev.filter((f) => f.id !== id));
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
    const url = `/api/maintenance/export${query ? `?${query}` : ""}`;
    const response = await fetch(url, {
      headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
    });
    if (!response.ok) {
      toast({ title: "Export failed", description: "Could not download the maintenance report. Please try again.", variant: "destructive" });
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    // Derive filename from Content-Disposition or fall back to a generated one
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `maintenance-history-${new Date().toISOString().slice(0, 10)}.csv`;
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
  const filteredReports = (reports as MaintenanceReportItem[] | undefined)?.filter((r) => {
    if (tab !== "resolved") return true;

    // Resolution type filter
    if (resolutionFilter !== "all" && r.resolution !== resolutionFilter) return false;

    // Date range filter — exclude records missing resolvedAt when a bounded filter is active
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

    // Keyword search filter
    const q = resolvedSearchQuery.trim().toLowerCase();
    if (q) {
      const matchesGuest = r.guestName.toLowerCase().includes(q);
      const matchesRoom = r.roomNumber.toLowerCase().includes(q);
      const matchesTitle = r.title.toLowerCase().includes(q);
      if (!matchesGuest && !matchesRoom && !matchesTitle) return false;
    }

    return true;
  });

  const isResolveSubmitting = isSubmittingExpense || resolveMutation.isPending;
  const hasUploadingFiles = receiptFiles.some((f) => f.uploading);

  return (
    <Layout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <Wrench className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Maintenance</h1>
              <p className="text-sm text-muted-foreground">
                Maintenance requests — open, action, and sign off
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
              <Wrench className="w-3 h-3" /> In Progress
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
            {/* Date range */}
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

            {/* Resolution type */}
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

            {/* Keyword search */}
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
          <div className="text-destructive text-sm">Failed to load maintenance requests.</div>
        )}

        {!isLoading && !isError && filteredReports?.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground gap-3">
            <CheckCircle2 className="w-10 h-10 opacity-30" />
            <p className="text-sm">
              {tab === "open"
                ? "No open maintenance requests."
                : tab === "in_progress"
                ? "No requests currently in progress."
                : "No resolved maintenance requests match the selected filters."}
            </p>
          </div>
        )}

        {/* Report cards */}
        <div className="space-y-3">
          {filteredReports?.map((report) => {
            const linkedExpense = expenseByReport.get(report.id);
            return (
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
                        {/* Expense claim badge (resolved tab only) */}
                        {linkedExpense && (
                          <Badge
                            variant="outline"
                            className="text-xs shrink-0 text-emerald-700 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-700"
                          >
                            <Receipt className="w-3 h-3 mr-1" />
                            ${parseFloat(linkedExpense.amountAud).toFixed(2)} claim submitted
                          </Badge>
                        )}
                        {/* Resolution note badge (resolved tab only) */}
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
                        <span>Room {report.roomNumber}</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {format(new Date(report.createdAt), "d MMM yyyy, h:mm a")}
                        </span>
                      </div>

                      {/* Description */}
                      <p className="text-sm text-foreground/80 mb-3">{report.description}</p>

                      {/* Audit trail */}
                      {(report.inProgressByName || report.resolvedByName) && (
                        <div className="mt-2 pt-3 border-t border-border space-y-1.5">
                          {report.inProgressByName && (
                            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                              <Wrench className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
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
                          {/* Expense claim detail — shown in audit trail when a claim is linked */}
                          {linkedExpense && (
                            <div className="flex items-start gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800 px-2.5 py-1.5">
                              <Receipt className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                              <span className="text-xs text-emerald-800 dark:text-emerald-300 leading-snug">
                                Expense submitted: <span className="font-semibold">${parseFloat(linkedExpense.amountAud).toFixed(2)} AUD</span>
                                {" — "}{linkedExpense.description}
                                {linkedExpense.project && (
                                  <span className="text-emerald-700 dark:text-emerald-400"> · {linkedExpense.project}</span>
                                )}
                              </span>
                            </div>
                          )}
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
                          <Wrench className="w-3.5 h-3.5 mr-1.5" />
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
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Create Request dialog ─────────────────────────────────────────── */}
      <Dialog open={showCreate} onOpenChange={(o) => { setShowCreate(o); setCreateError(""); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-4 h-4" /> New Maintenance Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Staff-raised requests are tracked the same way as guest reports and require sign-off before closing.
            </p>
            <div className="space-y-1.5">
              <Label>Room / Location</Label>
              <Input
                placeholder="e.g. 12, Laundry, Pool area"
                value={createRoom}
                onChange={(e) => setCreateRoom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Issue title</Label>
              <Input
                placeholder="e.g. Broken gate latch"
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                maxLength={100}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Details</Label>
              <Textarea
                placeholder="Describe what was found and where exactly"
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
                        // Reset the input so selecting the same file again still fires onChange
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
                <p className="text-muted-foreground mt-0.5">Room {escalateTarget.roomNumber} · {escalateTarget.guestName}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                This will mark the report as <strong>Urgent</strong> and send an immediate push notification to all subscribed staff.
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
      <Dialog open={!!ackTarget} onOpenChange={(o) => { if (!o) { setAckTarget(null); setAckNote(""); setAckSignature(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wrench className="w-4 h-4 text-blue-500" /> Acknowledge Report
            </DialogTitle>
          </DialogHeader>
          {ackTarget && (
            <div className="space-y-4 py-2">
              <div className="bg-muted rounded-lg p-3 text-sm">
                <p className="font-semibold">{ackTarget.title}</p>
                <p className="text-muted-foreground mt-0.5">Room {ackTarget.roomNumber} · {ackTarget.guestName}</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Acknowledging moves this report to <strong>In Progress</strong>. Select your name and add a note to record who it's assigned to or any initial actions taken.
              </p>
              <div className="space-y-1.5">
                <Label>
                  Acknowledged by <span className="text-destructive">*</span>
                </Label>
                <Select value={ackSignature} onValueChange={setAckSignature}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select your name…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Dennis">Dennis</SelectItem>
                    <SelectItem value="Geraldo">Geraldo</SelectItem>
                    <SelectItem value="Narahari">Narahari</SelectItem>
                    <SelectItem value="Mathuradis">Mathuradis</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Note (optional)</Label>
                <Textarea
                  placeholder="e.g. Assigned to external plumber — expected Friday"
                  value={ackNote}
                  onChange={(e) => setAckNote(e.target.value)}
                  rows={3}
                  maxLength={300}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAckTarget(null)}>Cancel</Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={handleAck}
              disabled={ackMutation.isPending || !ackSignature.trim()}
              title={!ackSignature.trim() ? "Select your name to acknowledge" : undefined}
            >
              {ackMutation.isPending ? "Saving…" : "Mark In Progress"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Resolve / Sign-Off dialog ─────────────────────────────────────── */}
      <Dialog
        open={!!resolveTarget}
        onOpenChange={(o) => {
          if (!o && !isResolveSubmitting) {
            // Prevent silent dismissal when receipts have been uploaded but
            // the expense fields are incomplete — surface an error instead so
            // staff don't lose their attached files without realising.
            const uploadedCount = receiptFiles.filter((f) => !f.uploading && f.url).length;
            const hasPartialExpense = uploadedCount > 0 || expenseProject.trim().length > 0;
            if (hasPartialExpense && (!expenseDesc.trim() || !expenseAmount.trim())) {
              setShowExpenseSection(true);
              setExpenseError(
                `You have ${uploadedCount === 1 ? "an uploaded receipt" : `${uploadedCount} uploaded receipts`}. Please complete the description and amount, or remove the receipts before closing.`,
              );
              return;
            }
            resetResolveDialog();
          }
        }}
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
                <p className="text-muted-foreground mt-0.5">Room {resolveTarget.roomNumber} · {resolveTarget.guestName}</p>
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
                    <SelectItem value="actioned">Actioned — issue fixed directly</SelectItem>
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
                    <SelectValue placeholder="Select your name…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Dennis">Dennis</SelectItem>
                    <SelectItem value="Geraldo">Geraldo</SelectItem>
                    <SelectItem value="Narahari">Narahari</SelectItem>
                    <SelectItem value="Mathuradis">Mathuradis</SelectItem>
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
                  placeholder="e.g. Washer replaced, tested and working."
                  value={resolveNote}
                  onChange={(e) => setResolveNote(e.target.value)}
                  rows={3}
                  maxLength={500}
                />
              </div>

              {/* ── Expense Claim section (collapsible) ─────────────────── */}
              <div className="border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowExpenseSection((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/50 transition-colors text-left"
                >
                  <span className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-emerald-600" />
                    Expense Claim
                    <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                  </span>
                  {showExpenseSection ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>

                {showExpenseSection && (
                  <div className="px-4 pb-4 pt-1 space-y-3 border-t bg-muted/20">
                    <p className="text-xs text-muted-foreground pt-1">
                      If you incurred out-of-pocket costs for this job, enter the details below.
                      The claim will be linked to this maintenance report.
                    </p>

                    {/* Description */}
                    <div className="space-y-1">
                      <Label className="text-xs">Description <span className="text-destructive">*</span></Label>
                      <Input
                        placeholder="e.g. Replacement washer and sealant"
                        value={expenseDesc}
                        onChange={(e) => setExpenseDesc(e.target.value)}
                        className="h-8 text-sm"
                        maxLength={200}
                      />
                    </div>

                    {/* Project tag + Amount side by side */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Project tag <span className="text-muted-foreground font-normal">(optional)</span></Label>
                        <Input
                          placeholder="e.g. Plumbing"
                          value={expenseProject}
                          onChange={(e) => setExpenseProject(e.target.value)}
                          className="h-8 text-sm"
                          maxLength={80}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Amount (AUD) <span className="text-destructive">*</span></Label>
                        <div className="relative">
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                          <Input
                            placeholder="0.00"
                            value={expenseAmount}
                            onChange={(e) => setExpenseAmount(e.target.value)}
                            className="h-8 text-sm pl-6"
                            inputMode="decimal"
                          />
                        </div>
                      </div>
                    </div>

                    {/* Receipt upload */}
                    <div className="space-y-1.5">
                      <Label className="text-xs">Receipts <span className="text-muted-foreground font-normal">(optional — photos or PDFs)</span></Label>

                      {/* Uploaded files list */}
                      {receiptFiles.length > 0 && (
                        <div className="space-y-1.5 mb-2">
                          {receiptFiles.map((f) => (
                            <div
                              key={f.id}
                              className="flex items-center gap-2 text-xs bg-background border rounded-md px-2.5 py-1.5"
                            >
                              {f.uploading ? (
                                <Loader2 className="w-3.5 h-3.5 text-muted-foreground animate-spin shrink-0" />
                              ) : (
                                <Paperclip className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                              )}
                              <span className="flex-1 truncate text-foreground/80">
                                {f.name}
                                {f.uploading && <span className="text-muted-foreground ml-1">Uploading…</span>}
                              </span>
                              {!f.uploading && (
                                <button
                                  type="button"
                                  onClick={() => removeReceipt(f.id)}
                                  className="text-muted-foreground hover:text-destructive shrink-0"
                                  aria-label={`Remove ${f.name}`}
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Hidden file input */}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
                        multiple
                        className="hidden"
                        onChange={handleFileSelect}
                      />

                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1.5"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={hasUploadingFiles}
                      >
                        <Paperclip className="w-3.5 h-3.5" />
                        {receiptFiles.length === 0 ? "Attach receipt" : "Add another"}
                      </Button>
                    </div>

                    {/* Expense error */}
                    {expenseError && (
                      <p className="text-xs text-destructive">{expenseError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={resetResolveDialog} disabled={isResolveSubmitting}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={handleResolve}
              disabled={isResolveSubmitting || !resolveSignature.trim() || hasUploadingFiles}
              title={
                !resolveSignature.trim()
                  ? "Select your name to confirm sign-off"
                  : hasUploadingFiles
                  ? "Wait for receipts to finish uploading"
                  : undefined
              }
            >
              {isResolveSubmitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  {isSubmittingExpense ? "Saving expense…" : "Saving…"}
                </>
              ) : (
                "Confirm Sign Off"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Photo viewer dialog (guest-uploaded photos on maintenance reports) ── */}
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
                  alt={`Maintenance photo ${photoViewerIndex + 1}`}
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
                Submitted by {photoViewerTarget.guestName} · Room {photoViewerTarget.roomNumber}
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
                a.download = `maintenance-${photoViewerTarget?.id}-photo-${photoViewerIndex + 1}.jpg`;
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
    </Layout>
  );
}
