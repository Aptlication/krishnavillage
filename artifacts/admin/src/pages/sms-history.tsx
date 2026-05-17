import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { format } from "date-fns";
import { MessageSquare, Phone, Clock, Filter } from "lucide-react";

interface SmsRow {
  id: number;
  tenantId: number;
  guestId: number | null;
  to: string;
  body: string;
  sentByStaffId: number | null;
  sentByName: string | null;
  provider: string;
  providerMessageId: string | null;
  status: "queued" | "sent" | "delivered" | "failed" | "undelivered" | "skipped_no_mobile";
  errorMessage: string | null;
  linkedMaintenanceReportId: number | null;
  linkedHousekeepingReportId: number | null;
  trigger: "manual" | "auto_acknowledge" | "auto_resolve" | "broadcast";
  createdAt: string;
  deliveredAt: string | null;
}

type StatusFilter = "all" | SmsRow["status"];
type TriggerFilter = "all" | SmsRow["trigger"];

const SMS_HISTORY_KEY = ["/api/sms/history"] as const;

function statusBadgeColour(s: SmsRow["status"]) {
  switch (s) {
    case "delivered":
      return "text-emerald-700 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-700";
    case "sent":
    case "queued":
      return "text-sky-700 border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-700";
    case "failed":
    case "undelivered":
      return "text-destructive border-destructive/40 bg-destructive/10";
    case "skipped_no_mobile":
      return "text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-700";
    default:
      return "";
  }
}

function triggerLabel(t: SmsRow["trigger"]) {
  if (t === "manual") return "Manual";
  if (t === "auto_acknowledge") return "Auto · Acknowledge";
  if (t === "auto_resolve") return "Auto · Sign-Off";
  return "Broadcast";
}

export default function SmsHistory() {
  const { session } = useAuth();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [triggerFilter, setTriggerFilter] = useState<TriggerFilter>("all");
  const [search, setSearch] = useState("");

  const { data, isLoading, isError } = useQuery({
    queryKey: SMS_HISTORY_KEY,
    enabled: !!session?.token,
    refetchInterval: 30_000,
    queryFn: async (): Promise<SmsRow[]> => {
      const res = await fetch("/api/sms/history?limit=200", {
        headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
      });
      if (!res.ok) throw new Error("Failed to load SMS history");
      return res.json();
    },
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (triggerFilter !== "all" && r.trigger !== triggerFilter) return false;
      const q = search.trim().toLowerCase();
      if (q) {
        const blob = `${r.to} ${r.sentByName ?? ""} ${r.body}`.toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  }, [data, statusFilter, triggerFilter, search]);

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <MessageSquare className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SMS History</h1>
            <p className="text-sm text-muted-foreground">
              Every outbound SMS — auto and manual. Status reconciles from Twilio webhooks within
              a few seconds.
            </p>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-5 pb-4 flex flex-wrap items-center gap-3">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
              <SelectTrigger className="w-44 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="delivered">Delivered</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="undelivered">Undelivered</SelectItem>
                <SelectItem value="skipped_no_mobile">Skipped (no mobile)</SelectItem>
              </SelectContent>
            </Select>
            <Select value={triggerFilter} onValueChange={(v) => setTriggerFilter(v as TriggerFilter)}>
              <SelectTrigger className="w-52 h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All triggers</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="auto_acknowledge">Auto · Acknowledge</SelectItem>
                <SelectItem value="auto_resolve">Auto · Sign-Off</SelectItem>
                <SelectItem value="broadcast">Broadcast</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="Search recipient, sender or body…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-72 h-8 text-xs"
            />
            <span className="text-xs text-muted-foreground ml-auto">
              Showing {filtered.length} of {data?.length ?? 0}
            </span>
          </CardContent>
        </Card>

        {isLoading && <p className="text-muted-foreground text-sm">Loading…</p>}
        {isError && <p className="text-destructive text-sm">Could not load SMS history.</p>}

        {!isLoading && !isError && filtered.length === 0 && (
          <p className="text-muted-foreground text-sm text-center py-12">
            No SMS messages match the current filters.
          </p>
        )}

        <div className="space-y-2">
          {filtered.map((row) => (
            <Card key={row.id} className="border-border">
              <CardContent className="pt-4 pb-3">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <Phone className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="font-mono text-sm">{row.to || "—"}</span>
                      <Badge variant="outline" className={`text-xs ${statusBadgeColour(row.status)}`}>
                        {row.status.replace(/_/g, " ")}
                      </Badge>
                      <Badge variant="outline" className="text-xs">{triggerLabel(row.trigger)}</Badge>
                      {row.provider !== "twilio" && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">{row.provider}</Badge>
                      )}
                    </div>
                    <p className="text-sm text-foreground/80 whitespace-pre-wrap line-clamp-4">{row.body}</p>
                    {row.errorMessage && (
                      <p className="text-xs text-destructive mt-1.5">Error: {row.errorMessage}</p>
                    )}
                  </div>
                  <div className="text-right text-xs text-muted-foreground shrink-0 space-y-0.5">
                    <div className="flex items-center gap-1 justify-end">
                      <Clock className="w-3 h-3" />
                      {format(new Date(row.createdAt), "d MMM yyyy, h:mm a")}
                    </div>
                    {row.sentByName && <div>by {row.sentByName}</div>}
                    {row.linkedMaintenanceReportId && (
                      <div className="text-blue-600">Maintenance #{row.linkedMaintenanceReportId}</div>
                    )}
                    {row.linkedHousekeepingReportId && (
                      <div className="text-emerald-600">Housekeeping #{row.linkedHousekeepingReportId}</div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </Layout>
  );
}
