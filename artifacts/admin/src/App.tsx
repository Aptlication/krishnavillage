import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { useGuestListWatcher } from "@/hooks/use-guest-list-watcher";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Guests from "@/pages/guests";
import Maintenance from "@/pages/maintenance";
import Housekeeping from "@/pages/housekeeping";
import SmsHistory from "@/pages/sms-history";
import SmsSettings from "@/pages/sms-settings";
import Notifications from "@/pages/notifications";
import Staff from "@/pages/staff";
import ExpensesPage from "@/pages/expenses-page";
import ServicesContent from "@/pages/services-content";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";

// Route all API calls through the admin server proxy so embedded-mode requests
// don't bypass it. BASE_URL is "/admin/" in embedded mode and "/" in standalone
// mode. Stripping the trailing slash gives "/admin" or "", and the api-client
// only prepends a non-empty string, so standalone mode is unaffected.
setBaseUrl(import.meta.env.BASE_URL.replace(/\/$/, "") || null);

setAuthTokenGetter(() => {
  try {
    const raw = localStorage.getItem("staffSession");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { session?: { token?: string }; token?: string };
    return parsed.session?.token ?? parsed.token ?? null;
  } catch {
    return null;
  }
});

const queryClient = new QueryClient();

function Router() {
  const { session } = useAuth();
  const [location, navigate] = useLocation();

  // Route guard: send unauthenticated users to /login, and authenticated users
  // away from /login. Runs after every render where session or location change.
  useEffect(() => {
    if (!session && location !== "/login") {
      navigate("/login", { replace: true });
    } else if (session && location === "/login") {
      navigate("/", { replace: true });
    }
  }, [session, location, navigate]);

  // While the guard is mid-redirect, render nothing rather than the current
  // route's page (which would otherwise flash protected content for one frame).
  if (!session && location !== "/login") return null;
  if (session && location === "/login") return null;

  return (
    <Switch>
      <Route path="/" component={Guests} />
      <Route path="/guests" component={Guests} />
      <Route path="/maintenance" component={Maintenance} />
      <Route path="/housekeeping" component={Housekeeping} />
      <Route path="/sms-history" component={SmsHistory} />
      <Route path="/sms-settings" component={SmsSettings} />
      <Route path="/notifications" component={Notifications} />
      <Route path="/staff" component={Staff} />
      <Route path="/expenses" component={ExpensesPage} />
      <Route path="/services" component={ServicesContent} />
      <Route path="/login" component={Login} />
      <Route component={NotFound} />
    </Switch>
  );
}

function GuestListWatcher() {
  // useGuestListWatcher internally gates its query on session.token, so it
  // is safe to mount unconditionally — it won't poll until login completes.
  useGuestListWatcher();
  return null;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <GuestListWatcher />
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
        <SonnerToaster position="top-right" richColors />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
