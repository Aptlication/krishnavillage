import { useState, useMemo, useCallback, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  useGetGuests,
  getGetGuestsQueryKey,
  useStaffDeleteGuest,
  useStaffRegisterGuest,
  AccommodationType,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Search, Send, Clock, DoorOpen, Users, RefreshCw, Trash2, Plus,
  Phone, Home, Tent, Building,
} from "lucide-react";
import { format } from "date-fns";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";

type AccType = (typeof AccommodationType)[keyof typeof AccommodationType];

export default function Guests() {
  const { session } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [guestToRemove, setGuestToRemove] = useState<{ id: number; name: string; roomNumber: string } | null>(null);

  // Register-guest dialog state. The dialog lets reception pre-create a guest
  // record so SMS notifications can fire even before the guest's device claims
  // the row via Returning Guest login.
  const [showRegister, setShowRegister] = useState(false);
  const [regName, setRegName] = useState("");
  const [regType, setRegType] = useState<AccType>("room");
  const [regRoom, setRegRoom] = useState("");
  const [regArrival, setRegArrival] = useState("");
  const [regMobile, setRegMobile] = useState("");
  const [regError, setRegError] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const { data: guests, isLoading, refetch, dataUpdatedAt } = useGetGuests(
    {},
    {
      query: {
        enabled: !!session?.token,
        queryKey: getGetGuestsQueryKey(),
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
      },
    }
  );

  const { mutate: removeGuest, isPending: isRemoving } = useStaffDeleteGuest({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetGuestsQueryKey() });
        setGuestToRemove(null);
      },
    },
  });

  const { mutate: staffRegister, isPending: isRegistering } = useStaffRegisterGuest({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetGuestsQueryKey() });
        toast({ title: "Guest registered", description: "The guest record is ready. They can claim it on first login." });
        setShowRegister(false);
        setRegName(""); setRegType("room"); setRegRoom(""); setRegArrival(""); setRegMobile("");
        setRegError(null);
      },
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; data?: { error?: string; code?: string } };
        if (apiErr?.status === 401) return;
        setRegError(apiErr?.data?.error ?? "Could not register guest. Please try again.");
      },
    },
  });

  useEffect(() => {
    if (dataUpdatedAt) setLastRefreshed(new Date(dataUpdatedAt));
  }, [dataUpdatedAt]);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try { await refetch(); } finally { setIsRefreshing(false); }
  }, [refetch]);

  const filteredGuests = useMemo(() => {
    if (!guests) return [];
    if (!search.trim()) return guests;
    const q = search.toLowerCase();
    return guests.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        g.roomNumber.toLowerCase().includes(q) ||
        (g.mobile ?? "").toLowerCase().includes(q),
    );
  }, [guests, search]);

  const handleNotifyGuest = (roomNumber: string) => {
    setLocation(`/notifications?room=${encodeURIComponent(roomNumber)}`);
  };

  const handleConfirmRemove = () => {
    if (!guestToRemove) return;
    removeGuest({ id: guestToRemove.id });
  };

  // ── Register-guest helpers ──────────────────────────────────────────────────
  // The roomNumber field is required for room/cabin, optional for camping_site.
  // Mobile is required everywhere (auto-SMS only works with a number on file).
  const isCamping = regType === "camping_site";

  function handleRegisterSubmit() {
    setRegError(null);
    if (!regName.trim()) { setRegError("Name is required."); return; }
    if (!isCamping && !regRoom.trim()) { setRegError("Room/cabin number is required."); return; }
    if (!regMobile.trim()) { setRegError("Mobile number is required for SMS notifications."); return; }
    staffRegister({
      data: {
        name: regName.trim(),
        accommodationType: regType,
        ...(regRoom.trim() ? { roomNumber: regRoom.trim() } : {}),
        ...(isCamping && regArrival ? { arrivalDate: regArrival } : {}),
        mobile: regMobile.trim(),
      },
    });
  }

  // Pick the right icon/label for the accommodation badge based on the row.
  function renderAccommodationBadge(g: { roomNumber: string; accommodationType?: AccType | null }) {
    const t = g.accommodationType ?? "room";
    if (t === "camping_site" || g.roomNumber.toUpperCase().startsWith("CAMP-")) {
      return (
        <Badge variant="outline" className="font-mono gap-1 text-emerald-700 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-700">
          <Tent className="w-3 h-3" /> {g.roomNumber}
        </Badge>
      );
    }
    if (t === "cabin") {
      return (
        <Badge variant="outline" className="font-mono gap-1 text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-700">
          <Building className="w-3 h-3" /> Cabin {g.roomNumber}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="font-mono gap-1 text-sky-700 border-sky-300 bg-sky-50 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-700">
        <Home className="w-3 h-3" /> Room {g.roomNumber}
      </Badge>
    );
  }

  return (
    <Layout>
      <div className="space-y-6 h-full flex flex-col">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 shrink-0">
          <div>
            <h2 className="text-2xl font-serif font-bold text-foreground">Registered Guests</h2>
            <p className="text-muted-foreground">Overview of all active room registrations.</p>
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
            <div className="relative flex-1 sm:max-w-sm">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, room or mobile..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
                data-testid="input-search-guests"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleManualRefresh}
              disabled={isRefreshing}
              data-testid="button-refresh-guests"
              className="shrink-0"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => setShowRegister(true)}
              data-testid="button-register-guest"
              className="shrink-0"
            >
              <Plus className="w-4 h-4 mr-2" />
              Register Guest
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 shrink-0">
          <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/10 text-primary rounded-lg">
              <Users className="w-5 h-5" />
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Total Guests</p>
              <p className="text-2xl font-semibold">{guests?.length || 0}</p>
            </div>
          </div>
        </div>

        <div className="flex-1 bg-card border border-border rounded-xl overflow-hidden flex flex-col">
          {lastRefreshed && (
            <div className="px-6 py-2 border-b border-border bg-muted/30 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="w-3 h-3" />
              Last updated {format(lastRefreshed, "h:mm:ss a")} — refreshes every 30 seconds
            </div>
          )}
          <div className="overflow-auto flex-1">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground bg-muted/50 uppercase sticky top-0 backdrop-blur-sm z-10">
                <tr>
                  <th className="px-6 py-4 font-medium">Surname</th>
                  <th className="px-6 py-4 font-medium">Accommodation</th>
                  <th className="px-6 py-4 font-medium">Mobile</th>
                  <th className="px-6 py-4 font-medium">Registered</th>
                  <th className="px-6 py-4 font-medium">Last Changed</th>
                  <th className="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-6 py-4"><div className="h-4 bg-muted rounded w-32"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-muted rounded w-16"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-muted rounded w-24"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-muted rounded w-24"></div></td>
                      <td className="px-6 py-4"><div className="h-4 bg-muted rounded w-24"></div></td>
                      <td className="px-6 py-4 text-right"><div className="h-8 bg-muted rounded w-24 ml-auto"></div></td>
                    </tr>
                  ))
                ) : filteredGuests.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                      No guests found.
                    </td>
                  </tr>
                ) : (
                  filteredGuests.map((guest) => {
                    const wasUpdated = guest.updatedAt !== guest.createdAt;
                    const accType = (guest.accommodationType ?? "room") as AccType;
                    return (
                      <tr
                        key={guest.id}
                        className="hover:bg-accent/50 transition-colors group"
                        data-testid={`row-guest-${guest.id}`}
                      >
                        <td className="px-6 py-4 font-medium text-foreground">{guest.name}</td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2 flex-wrap">
                            {renderAccommodationBadge({ roomNumber: guest.roomNumber, accommodationType: accType })}
                            {accType === "camping_site" && guest.arrivalDate && (
                              <span className="text-xs text-muted-foreground">arrived {guest.arrivalDate}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">
                          {guest.mobile ? (
                            <a
                              href={`tel:${guest.mobile}`}
                              className="inline-flex items-center gap-1.5 font-mono text-foreground hover:text-primary"
                              data-testid={`mobile-${guest.id}`}
                            >
                              <Phone className="w-3.5 h-3.5" />
                              {guest.mobile}
                            </a>
                          ) : (
                            <span className="text-muted-foreground/50 italic">no mobile</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-4 h-4" />
                            {format(new Date(guest.createdAt), "MMM d, h:mm a")}
                          </div>
                        </td>
                        <td className="px-6 py-4 text-muted-foreground">
                          {wasUpdated ? (
                            <div className="flex items-center gap-1.5">
                              <Clock className="w-4 h-4 text-amber-500" />
                              <span className="text-amber-600 dark:text-amber-400">
                                {format(new Date(guest.updatedAt), "MMM d, h:mm a")}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground/50">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="opacity-60 group-hover:opacity-100 transition-opacity"
                              onClick={() => handleNotifyGuest(guest.roomNumber)}
                              data-testid={`button-notify-${guest.id}`}
                            >
                              <Send className="w-4 h-4 mr-2" />
                              Notify
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="opacity-60 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:border-destructive/50"
                              onClick={() => setGuestToRemove({ id: guest.id, name: guest.name, roomNumber: guest.roomNumber })}
                              data-testid={`button-remove-${guest.id}`}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Remove
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ── Register Guest dialog ───────────────────────────────────────────── */}
      <Dialog open={showRegister} onOpenChange={(o) => { setShowRegister(o); if (!o) setRegError(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-4 h-4" /> Register Guest
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Pre-create a guest record so SMS notifications can fire from day one. The guest can claim
              the record on their device later via the <strong>Returning Guest</strong> login.
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="reg-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="reg-name"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                placeholder="e.g. Sharma"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label>Type of accommodation <span className="text-destructive">*</span></Label>
              <Select value={regType} onValueChange={(v) => setRegType(v as AccType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="room">Room</SelectItem>
                  <SelectItem value="cabin">Cabin</SelectItem>
                  <SelectItem value="camping_site">Camping Site</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reg-room">
                {isCamping ? (
                  <>Site number <span className="text-muted-foreground font-normal text-xs">(optional — auto-assigned if blank)</span></>
                ) : (
                  <>{regType === "cabin" ? "Cabin" : "Room"} number <span className="text-destructive">*</span></>
                )}
              </Label>
              <Input
                id="reg-room"
                value={regRoom}
                onChange={(e) => setRegRoom(e.target.value)}
                placeholder={isCamping ? "e.g. Tent A (leave blank for auto CAMP-NNN)" : "e.g. 12"}
                autoCapitalize="characters"
              />
            </div>

            {isCamping && (
              <div className="space-y-1.5">
                <Label htmlFor="reg-arrival">Arrival date <span className="text-muted-foreground font-normal text-xs">(used for returning-guest lookup)</span></Label>
                <Input
                  id="reg-arrival"
                  type="date"
                  value={regArrival}
                  onChange={(e) => setRegArrival(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="reg-mobile">
                Mobile <span className="text-destructive">*</span>
              </Label>
              <Input
                id="reg-mobile"
                type="tel"
                inputMode="tel"
                value={regMobile}
                onChange={(e) => setRegMobile(e.target.value)}
                placeholder="0412 345 678"
              />
              <p className="text-xs text-muted-foreground">
                Required — Krishna Village staff will send the guest SMS notifications about
                maintenance, housekeeping and reception updates.
              </p>
            </div>

            {regError && <p className="text-sm text-destructive">{regError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRegister(false)} disabled={isRegistering}>Cancel</Button>
            <Button onClick={handleRegisterSubmit} disabled={isRegistering}>
              {isRegistering ? "Saving…" : "Register Guest"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!guestToRemove} onOpenChange={(open) => { if (!open) setGuestToRemove(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Guest</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove <strong>{guestToRemove?.name}</strong> ({guestToRemove?.roomNumber}) from the guest list? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmRemove}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-remove"
            >
              {isRemoving ? "Removing..." : "Remove Guest"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Layout>
  );
}
