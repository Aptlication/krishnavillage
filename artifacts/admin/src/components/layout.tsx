import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import {
  Users, Bell, LogOut, HeartPulse, ShieldCheck, Wrench, Sparkles, Receipt, BookOpen,
  MessageSquare, Settings as SettingsIcon, Menu, ChevronLeft,
} from "lucide-react";
import {
  useHealthCheck,
  useGetGuests,
  getGetGuestsQueryKey,
  useGetMaintenanceReports,
  getGetMaintenanceReportsQueryKey,
  useGetHousekeepingReports,
  getGetHousekeepingReportsQueryKey,
  useGetExpensePendingCount,
  getGetExpensePendingCountQueryKey,
  useGetNotifications,
  getGetNotificationsQueryKey,
} from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const { logout, session } = useAuth();

  const handleLogout = () => {
    logout();
    navigate("/guests");
  };

  // Mobile-only collapsing nav for the Maintenance section. The maintenance
  // workflow is dense and the stacked sidebar steals most of the viewport on
  // handheld devices, so we hide the nav on mobile when /maintenance is the
  // active route. The user can reopen it via a floating button or via the
  // "Hide menu" control inside the nav. Leaving /maintenance, or crossing the
  // md breakpoint, restores the nav automatically.
  const [navHidden, setNavHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return location === "/maintenance" && window.matchMedia("(max-width: 767.98px)").matches;
  });
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767.98px)");
    const sync = () => setNavHidden(mql.matches && location === "/maintenance");
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [location]);

  const { data: health } = useHealthCheck();
  const { data: guests } = useGetGuests(
    {},
    {
      query: {
        queryKey: getGetGuestsQueryKey({}),
        enabled: !!session?.token,
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
      },
    }
  );
  const guestCount = guests?.length;
  const { data: maintenanceReports } = useGetMaintenanceReports(undefined, {
    query: {
      queryKey: getGetMaintenanceReportsQueryKey({}),
      enabled: !!session?.token,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });
  const openMaintenanceCount = maintenanceReports?.filter(
    (r) => r.status === "open" || r.status === "in_progress"
  ).length;
  const { data: housekeepingReports } = useGetHousekeepingReports(undefined, {
    query: {
      queryKey: getGetHousekeepingReportsQueryKey({}),
      enabled: !!session?.token,
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });
  const openHousekeepingCount = housekeepingReports?.filter(
    (r) => r.status === "open" || r.status === "in_progress"
  ).length;
  const { data: expensePending } = useGetExpensePendingCount({
    query: {
      queryKey: getGetExpensePendingCountQueryKey(),
      enabled: session?.role === "admin",
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });
  const pendingExpenseCount = expensePending?.count;
  const { data: notifications } = useGetNotifications(undefined, {
    query: {
      queryKey: getGetNotificationsQueryKey(),
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const unseenNotificationCount = (() => {
    if (location === "/notifications") return 0;
    if (!notifications || !session?.staffId) return undefined;
    const raw = localStorage.getItem(`notificationsLastViewed_${session.staffId}`);
    const parsed = Number(raw);
    const lastViewed = raw && Number.isFinite(parsed) ? parsed : 0;
    return notifications.filter((n) => new Date(n.sentAt).getTime() > lastViewed).length;
  })();

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Floating reopen button — only rendered when nav is collapsed on mobile */}
      {navHidden && (
        <button
          type="button"
          onClick={() => setNavHidden(false)}
          aria-label="Open navigation"
          data-testid="button-open-nav"
          className="md:hidden fixed top-3 left-3 z-50 h-11 w-11 rounded-full bg-card border border-border shadow-md flex items-center justify-center text-foreground hover:bg-accent transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
      )}
      <aside
        data-testid="sidebar"
        className={`w-full md:w-64 bg-card border-r border-border shrink-0 ${navHidden ? "hidden md:flex" : "flex"} flex-col`}
      >
        <div className="p-6">
          <div className="flex items-center gap-3 mb-0.5">
            <img src={`${import.meta.env.BASE_URL}kv-icon.png`} alt="KV" className="w-9 h-9 rounded-lg object-contain" />
            <div className="flex flex-col">
              <h1
                className="text-xl tracking-wide leading-tight"
                style={{ fontFamily: "'Playfair Display', serif", fontWeight: 400, color: '#1a5276' }}
              >Krishna Village</h1>
              <span
                className="text-xs leading-tight"
                style={{ fontFamily: "'Cormorant SC', serif", fontWeight: 300, letterSpacing: '0.12em', color: '#2e86c1' }}
              >Eco Yoga Community</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider pl-12 mt-1">Staff Dashboard</p>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          <Link href="/guests">
            <div
              data-testid="nav-guests"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/guests"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Users className="w-4 h-4" />
              Guests
              {guestCount !== undefined && (
                <span className="ml-auto text-xs font-semibold bg-primary/15 text-primary rounded-full px-2 py-0.5 min-w-[1.5rem] text-center">
                  {guestCount}
                </span>
              )}
            </div>
          </Link>
          <Link href="/maintenance">
            <div
              data-testid="nav-maintenance"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/maintenance"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Wrench className="w-4 h-4" />
              Maintenance
              {openMaintenanceCount !== undefined && openMaintenanceCount > 0 && (
                <span className="ml-auto text-xs font-semibold bg-primary/15 text-primary rounded-full px-2 py-0.5 min-w-[1.5rem] text-center">
                  {openMaintenanceCount}
                </span>
              )}
            </div>
          </Link>
          <Link href="/housekeeping">
            <div
              data-testid="nav-housekeeping"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/housekeeping"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Sparkles className="w-4 h-4" />
              Housekeeping
              {openHousekeepingCount !== undefined && openHousekeepingCount > 0 && (
                <span className="ml-auto text-xs font-semibold bg-primary/15 text-primary rounded-full px-2 py-0.5 min-w-[1.5rem] text-center">
                  {openHousekeepingCount}
                </span>
              )}
            </div>
          </Link>
          <Link href="/notifications">
            <div
              data-testid="nav-notifications"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/notifications"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Bell className="w-4 h-4" />
              Notifications
              {unseenNotificationCount !== undefined && unseenNotificationCount > 0 && (
                <span className="ml-auto text-xs font-semibold bg-primary/15 text-primary rounded-full px-2 py-0.5 min-w-[1.5rem] text-center">
                  {unseenNotificationCount}
                </span>
              )}
            </div>
          </Link>
          <Link href="/staff">
            <div
              data-testid="nav-staff"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/staff"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <ShieldCheck className="w-4 h-4" />
              {session?.role === "admin" ? "Staff Accounts" : "My Account"}
            </div>
          </Link>
          <Link href="/expenses">
            <div
              data-testid="nav-expenses"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/expenses"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <Receipt className="w-4 h-4" />
              Expenses &amp; Reimbursements
              {pendingExpenseCount !== undefined && pendingExpenseCount > 0 && (
                <span className="ml-auto text-xs font-semibold bg-amber-100 text-amber-800 rounded-full px-2 py-0.5 min-w-[1.5rem] text-center">
                  {pendingExpenseCount}
                </span>
              )}
            </div>
          </Link>
          <Link href="/sms-history">
            <div
              data-testid="nav-sms-history"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/sms-history"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              SMS History
            </div>
          </Link>
          <Link href="/sms-settings">
            <div
              data-testid="nav-sms-settings"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/sms-settings"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <SettingsIcon className="w-4 h-4" />
              SMS Settings
            </div>
          </Link>
          <Link href="/services">
            <div
              data-testid="nav-services"
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors ${
                location === "/services"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <BookOpen className="w-4 h-4" />
              Services Content
            </div>
          </Link>
        </nav>

        <div className="p-4 border-t border-border mt-auto">
          {/* Mobile-only "Hide menu" — collapses the nav so the user gets the
              full viewport for the maintenance content */}
          <button
            type="button"
            onClick={() => setNavHidden(true)}
            data-testid="button-hide-nav"
            className="md:hidden flex items-center gap-3 px-3 py-2.5 w-full rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-left mb-2"
          >
            <ChevronLeft className="w-4 h-4" />
            Hide menu
          </button>
          {session && (
            <div className="px-3 py-2 mb-1 text-xs text-muted-foreground truncate">
              Signed in as <span className="font-medium text-foreground">{session.displayName}</span>
            </div>
          )}
          <div className="flex items-center gap-2 px-3 py-2 mb-2 text-xs text-muted-foreground">
            <HeartPulse className="w-3.5 h-3.5" />
            <span>System: {health?.status === "ok" ? "Online" : "Checking..."}</span>
          </div>
          <button
            onClick={handleLogout}
            data-testid="button-logout"
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-md text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors text-left"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden">
        <div
          className={`flex-1 overflow-auto md:p-8 ${navHidden ? "px-4 pt-16 pb-4" : "p-4"}`}
        >
          <div className="max-w-5xl mx-auto h-full">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
