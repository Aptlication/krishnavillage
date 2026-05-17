import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Layout } from "@/components/layout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { MessageSquare, Save, Loader2 } from "lucide-react";

interface SmsSettings {
  smsAutoSendOnAcknowledge: boolean;
  smsAutoSendOnResolve: boolean;
  smsFooter: string;
}

const SMS_SETTINGS_KEY = ["/api/sms/settings"] as const;

export default function SmsSettings() {
  const { session } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: SMS_SETTINGS_KEY,
    enabled: !!session?.token,
    queryFn: async (): Promise<SmsSettings> => {
      const res = await fetch("/api/sms/settings", {
        headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
      });
      if (!res.ok) throw new Error("Failed to load SMS settings");
      return res.json();
    },
  });

  // Local form state — populated from server on first load, then user-editable.
  const [autoAck, setAutoAck] = useState(true);
  const [autoResolve, setAutoResolve] = useState(true);
  const [footer, setFooter] = useState("");

  useEffect(() => {
    if (data) {
      setAutoAck(data.smsAutoSendOnAcknowledge);
      setAutoResolve(data.smsAutoSendOnResolve);
      setFooter(data.smsFooter);
    }
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sms/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: JSON.stringify({
          smsAutoSendOnAcknowledge: autoAck,
          smsAutoSendOnResolve: autoResolve,
          smsFooter: footer,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to save SMS settings");
      }
      return res.json() as Promise<SmsSettings>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SMS_SETTINGS_KEY });
      toast({ title: "SMS settings saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Could not save settings", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Layout>
      <div className="max-w-2xl space-y-6">
        <div className="flex items-center gap-3">
          <MessageSquare className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">SMS Settings</h1>
            <p className="text-sm text-muted-foreground">
              Control the auto-SMS that fires on Acknowledge and Sign-Off, and edit the footer
              appended to every outbound message.
            </p>
          </div>
        </div>

        {isLoading && <p className="text-muted-foreground text-sm">Loading settings…</p>}
        {isError && <p className="text-destructive text-sm">Could not load SMS settings.</p>}

        {!isLoading && !isError && (
          <>
            {/* Auto-send toggles */}
            <Card>
              <CardContent className="pt-6 space-y-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1 flex-1">
                    <Label htmlFor="auto-ack" className="text-sm font-medium">
                      Auto-SMS on Acknowledge
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Fires when a Maintenance or Housekeeping report moves to In&nbsp;Progress.
                      The ETA chosen in the dialog is woven into the message.
                    </p>
                  </div>
                  <Switch id="auto-ack" checked={autoAck} onCheckedChange={setAutoAck} />
                </div>

                <div className="flex items-start justify-between gap-4 pt-2 border-t">
                  <div className="space-y-1 flex-1">
                    <Label htmlFor="auto-resolve" className="text-sm font-medium">
                      Auto-SMS on Sign-Off
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Fires when a report is resolved/signed off. Confirms the work is complete.
                    </p>
                  </div>
                  <Switch id="auto-resolve" checked={autoResolve} onCheckedChange={setAutoResolve} />
                </div>
              </CardContent>
            </Card>

            {/* Footer editor */}
            <Card>
              <CardContent className="pt-6 space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="footer" className="text-sm font-medium">SMS footer</Label>
                  <p className="text-xs text-muted-foreground">
                    Appended to every outbound SMS (auto and manual). Keep this short — every
                    extra ~70 characters adds another SMS segment to the cost.
                  </p>
                </div>
                <Textarea
                  id="footer"
                  value={footer}
                  onChange={(e) => setFooter(e.target.value)}
                  rows={4}
                  maxLength={400}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {footer.length} / 400 characters
                </p>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving…</>
                ) : (
                  <><Save className="w-4 h-4 mr-2" />Save changes</>
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}
