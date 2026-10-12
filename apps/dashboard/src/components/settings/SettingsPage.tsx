"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  Server,
  ShieldQuestion,
  User as UserIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useDnsInfo } from "@/hooks/useDnsInfo";
import { useSystemSettings } from "@/hooks/useSystemSettings";
import { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/datetime";
import {
  useRefreshAnimation,
  refreshIconClassName,
} from "@/hooks/useRefreshAnimation";
import { TwoFactorCard } from "./TwoFactorCard";
import { SystemEmailCard } from "./SystemEmailCard";
import { GitHubCard } from "./GitHubCard";
import type { DnsRecordVerification } from "@vexlyx/shared";

// IANA timezone identifiers, sourced from the runtime's own tz database
// rather than a hardcoded list. Falls back to a short common set on very
// old browsers that lack Intl.supportedValuesOf.
function listTimezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [
      "UTC",
      "America/New_York",
      "America/Los_Angeles",
      "Europe/London",
      "Europe/Berlin",
      "Asia/Tokyo",
    ];
  }
}

/**
 * Settings page (F5.11): read-only account info, self-service password
 * change, and — for ADMIN users only, once F5.9 has real values to show —
 * the server's public IP and required DNS records.
 */
export function SettingsPage() {
  const { user, changePassword } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const {
    info,
    isLoading: isDnsLoading,
    refresh: refreshDns,
    verification,
    isVerifying,
    verify: verifyDns,
  } = useDnsInfo(isAdmin);
  const {
    settings: tzSettings,
    isLoading: isTzLoading,
    updateTimezone,
    isSaving: isSavingTz,
  } = useSystemSettings();
  const [timezone, setTimezone] = useState<string | null>(null);

  useEffect(() => {
    if (tzSettings && timezone === null) {
      setTimezone(tzSettings.timezone);
    }
  }, [tzSettings, timezone]);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const { isRefreshing: isRefreshingDns, refresh: refreshDnsAnimation } =
    useRefreshAnimation();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleChangePassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setPasswordError("Passwords do not match");
      return;
    }

    setIsChangingPassword(true);
    try {
      await changePassword(currentPassword, newPassword, confirmNewPassword);
      toast.success("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
    } catch (err) {
      const message =
        err instanceof ApiRequestError
          ? err.message
          : "Failed to change password";
      setPasswordError(message);
      toast.error(message);
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleRefreshDns = () => refreshDnsAnimation(() => refreshDns());

  const handleSaveTimezone = () => {
    if (timezone) updateTimezone(timezone);
  };

  const copyRecord = (text: string, index: number) => {
    void navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
    toast.success("Copied to clipboard");
  };

  const handleVerifyDns = async () => {
    try {
      const result = await verifyDns();
      const allPropagated = result.results.every((r) => r.isPropagated);
      if (allPropagated) {
        toast.success("All DNS records are live");
      } else {
        toast.info(
          "Some records haven't propagated yet — this can take a few minutes to hours",
        );
      }
    } catch {
      toast.error("Failed to check DNS records");
    }
  };

  const verificationFor = (
    type: "A" | "MX",
    host: string,
  ): DnsRecordVerification | undefined =>
    verification?.results.find((r) => r.type === type && r.host === host);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Account details and server reference info.
        </p>
      </div>

      {/* Account Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserIcon className="h-4 w-4" />
            Account
          </CardTitle>
          <CardDescription>Your Vexlyx account details.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div>
            <span className="text-xs text-muted-foreground">Name</span>
            <p className="mt-1 text-sm font-medium">{user?.name}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Email</span>
            <p className="mt-1 text-sm font-medium">{user?.email}</p>
          </div>
          <div>
            <span className="text-xs text-muted-foreground">Role</span>
            <p className="mt-1 text-sm font-medium">{user?.role}</p>
          </div>
        </CardContent>
      </Card>

      {/* Change Password */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            Change Password
          </CardTitle>
          <CardDescription>
            Update the password used to sign in to this panel.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="max-w-sm space-y-4">
            {passwordError && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {passwordError}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={isChangingPassword}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                placeholder="Min 8 characters"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={isChangingPassword}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-new-password">Confirm new password</Label>
              <Input
                id="confirm-new-password"
                type="password"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
                disabled={isChangingPassword}
                required
              />
            </div>
            <Button type="submit" disabled={isChangingPassword}>
              {isChangingPassword ? "Changing…" : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Two-Factor Authentication (F5.17) */}
      <TwoFactorCard />

      <GitHubCard />

      {/* Server Timezone (F5.13) — governs the backup cron's wall-clock time
          and (where adopted) how timestamps are displayed across the dashboard. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" />
            Server Timezone
          </CardTitle>
          <CardDescription>
            {isAdmin
              ? "Used for the backup schedule's wall-clock time and dashboard timestamps."
              : "The timezone this server's timestamps and backup schedule use."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isTzLoading ? (
            <Skeleton className="h-9 w-64" />
          ) : isAdmin ? (
            <div className="max-w-sm space-y-3">
              <Select value={timezone ?? undefined} onValueChange={setTimezone}>
                <SelectTrigger id="server-timezone">
                  <SelectValue placeholder="Select a timezone" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {listTimezones().map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={handleSaveTimezone}
                disabled={
                  isSavingTz || !timezone || timezone === tzSettings?.timezone
                }
                className="gap-1.5"
              >
                {isSavingTz && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save Timezone
              </Button>
            </div>
          ) : (
            <p className="text-sm font-medium">{tzSettings?.timezone}</p>
          )}
        </CardContent>
      </Card>

      {/* System transactional email status (F5.23), ADMIN only */}
      {isAdmin && <SystemEmailCard />}

      {/* DNS Records & Public IP reference (F5.9), ADMIN only */}
      {isAdmin && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Server className="h-4 w-4" />
                DNS Records &amp; Public IP
              </CardTitle>
              <CardDescription>
                Reference info from the installer — point these DNS records at
                your server.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleRefreshDns()}
              disabled={isRefreshingDns || isDnsLoading}
            >
              <RefreshCw
                className={refreshIconClassName(isRefreshingDns, "h-4 w-4")}
              />
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {isDnsLoading && !info ? (
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : !info?.publicIp ? (
              <p className="text-sm text-muted-foreground">
                No public IP was detected for this server during install. Set{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  VEXLYX_PUBLIC_IP
                </code>{" "}
                manually in{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  /etc/vexlyx/vexlyx.env
                </code>{" "}
                if you know it, then re-run the installer.
              </p>
            ) : (
              <>
                <div>
                  <span className="text-xs text-muted-foreground">
                    Server public IP
                  </span>
                  <p className="mt-1 font-mono text-sm font-medium">
                    {info.publicIp}
                  </p>
                </div>

                <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  Log in to your domain registrar or DNS provider (e.g.
                  Cloudflare, Namecheap, Route 53) and add each record below
                  with the displayed type and value. Propagation usually takes a
                  few minutes, but can take up to 48 hours depending on your
                  provider — use <span className="font-medium">Verify</span>{" "}
                  below to check.
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {verification
                      ? `Last checked ${formatTime(verification.checkedAt, tzSettings?.timezone)}`
                      : "Not checked yet"}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleVerifyDns()}
                    disabled={isVerifying}
                  >
                    <ShieldQuestion
                      className={cn(
                        "h-3.5 w-3.5",
                        isVerifying && "animate-pulse",
                      )}
                    />
                    {isVerifying ? "Checking…" : "Verify DNS"}
                  </Button>
                </div>

                <div className="space-y-2">
                  {info.records.map((record, i) => {
                    const priority =
                      record.priority === undefined
                        ? ""
                        : ` priority ${record.priority}`;
                    const line = `${record.type} ${record.host} -> ${record.value}${priority}`;
                    const result = verificationFor(record.type, record.host);
                    return (
                      <div
                        key={`${record.host}-${i}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs font-medium">
                            {record.host}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {record.purpose} — {record.type} → {record.value}
                            {record.priority === undefined
                              ? ""
                              : ` (priority ${record.priority})`}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {result && <DnsVerificationBadge result={result} />}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copyRecord(line, i)}
                          >
                            {copiedIndex === i ? (
                              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                  The mail-host A and mail-domain MX records enable inbound
                  delivery. Publish SPF, DKIM, and DMARC from{" "}
                  <span className="font-medium">Settings → System Email</span>.
                  Configure PTR/reverse DNS with your hosting provider and allow
                  inbound TCP ports 25, 587, and 993. If outbound TCP/25 is
                  blocked, configure an authenticated SMTP relay for panel
                  email.
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Summarizes one record's cross-resolver check into a single badge: MATCH
// on every resolver queried means it's live; anything else (still
// propagating, pointed elsewhere, or a lookup error) reads as "not yet" —
// the per-resolver detail isn't worth surfacing here, just the outcome.
function DnsVerificationBadge({ result }: { result: DnsRecordVerification }) {
  if (result.isPropagated) {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      >
        <CheckCircle2 className="h-3 w-3" />
        Live
      </Badge>
    );
  }

  const hasAnyResponse = result.resolvers.some(
    (r) => r.detectedValues.length > 0,
  );
  if (hasAnyResponse) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      >
        <Clock className="h-3 w-3" />
        Not pointed here yet
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-rose-500/20 bg-rose-500/10 text-rose-600 dark:text-rose-400"
    >
      <AlertCircle className="h-3 w-3" />
      Not found
    </Badge>
  );
}
