"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ApiRequestError } from "@/lib/api";
import type { Role, Permission, UserResponse, UpdateUserQuotasInput } from "@vexlyx/shared";

interface EditUserDialogProps {
  user: UserResponse | null;
  isSaving: boolean;
  /**
   * Only an ADMIN may change roles or grant permissions — a RESELLER
   * editing their own sub-account never sees these fields, and neither does
   * an ADMIN editing their own account (see `isSelf`).
   */
  canEditRole: boolean;
  /** True when the signed-in user is editing their own account. An ADMIN can never change their own role — it could lock them (and everyone) out — so the role/permissions fields are hidden and this drives the explanatory copy instead. */
  isSelf: boolean;
  /**
   * ADMIN-only 2FA reset (F5.17). Never shown for self — an ADMIN who lost
   * their own authenticator must be reset by another ADMIN directly.
   */
  canReset2FA: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, data: { role?: Role; quotas: UpdateUserQuotasInput; permissions?: Permission[] }) => Promise<void>;
  onReset2FA: (id: string) => Promise<void>;
}

type QuotaField = "maxProjects" | "maxDomains" | "maxDatabases" | "maxMailboxes" | "maxSubAccounts" | "maxScheduledTasks";

const QUOTA_FIELDS: { key: QuotaField; label: string }[] = [
  { key: "maxProjects", label: "Max projects" },
  { key: "maxDomains", label: "Max domains" },
  { key: "maxDatabases", label: "Max databases" },
  { key: "maxMailboxes", label: "Max mailboxes" },
  { key: "maxSubAccounts", label: "Max sub-accounts" },
  { key: "maxScheduledTasks", label: "Max scheduled tasks" },
];

const PERMISSION_FIELDS: { key: Permission; label: string; description: string }[] = [
  { key: "canManageDns", label: "Manage DNS", description: "View and verify server DNS records" },
  { key: "canManageFirewall", label: "Manage firewall", description: "Add, remove, and configure firewall rules" },
  { key: "canManageBackups", label: "Manage backups", description: "Trigger, restore, and configure backups" },
  { key: "canCreateSubAccounts", label: "Create sub-accounts", description: "Create sub-accounts without a Reseller role" },
];

function toFormValue(v: number | null): string {
  return v === null ? "" : String(v);
}

function fromFormValue(v: string): number | null {
  return v.trim() === "" ? null : Number(v);
}

export function EditUserDialog({ user, isSaving, canEditRole, isSelf, canReset2FA, onOpenChange, onSave, onReset2FA }: EditUserDialogProps) {
  const [role, setRole] = useState<Role>("USER");
  const [quotas, setQuotas] = useState<Record<QuotaField, string>>({
    maxProjects: "",
    maxDomains: "",
    maxDatabases: "",
    maxMailboxes: "",
    maxSubAccounts: "",
    maxScheduledTasks: "",
  });
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [oversellingEnabled, setOversellingEnabled] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    if (!user) return;
    setRole(user.role);
    setQuotas({
      maxProjects: toFormValue(user.maxProjects),
      maxDomains: toFormValue(user.maxDomains),
      maxDatabases: toFormValue(user.maxDatabases),
      maxMailboxes: toFormValue(user.maxMailboxes),
      maxSubAccounts: toFormValue(user.maxSubAccounts),
      maxScheduledTasks: toFormValue(user.maxScheduledTasks),
    });
    setPermissions(user.permissions);
    setOversellingEnabled(user.oversellingEnabled);
  }, [user]);

  // Only an ADMIN can toggle overselling, and only for a RESELLER target —
  // matches the service-layer enforcement in updateQuotas (F5.20).
  const canEditOverselling = canEditRole && role === "RESELLER";

  const togglePermission = (key: Permission, checked: boolean) => {
    setPermissions((prev) => (checked ? [...prev, key] : prev.filter((p) => p !== key)));
  };

  const handleSave = async () => {
    if (!user) return;
    await onSave(user.id, {
      role: canEditRole && role !== user.role ? role : undefined,
      quotas: {
        maxProjects: fromFormValue(quotas.maxProjects),
        maxDomains: fromFormValue(quotas.maxDomains),
        maxDatabases: fromFormValue(quotas.maxDatabases),
        maxMailboxes: fromFormValue(quotas.maxMailboxes),
        maxSubAccounts: fromFormValue(quotas.maxSubAccounts),
        maxScheduledTasks: fromFormValue(quotas.maxScheduledTasks),
        oversellingEnabled: canEditOverselling ? oversellingEnabled : undefined,
      },
      permissions: canEditRole ? permissions : undefined,
    });
  };

  const handleReset2FA = async () => {
    if (!user) return;
    setIsResetting(true);
    try {
      await onReset2FA(user.id);
      toast.success("Two-factor authentication reset");
      setShowResetConfirm(false);
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : "Failed to reset 2FA");
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <>
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>
            {isSelf
              ? "You can't change your own role or permissions — only quotas. Leave a quota blank for unlimited."
              : canEditRole
                ? `Change ${user?.name}'s role and resource quotas. Leave a quota blank for unlimited.`
                : `Change ${user?.name}'s resource quotas. Leave a quota blank for unlimited.`}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 space-y-4 overflow-y-auto px-6">
          {canEditRole && (
            <div className="space-y-1.5">
              <Label htmlFor="user-role">Role</Label>
              <Select value={role} onValueChange={(v: Role) => setRole(v)}>
                <SelectTrigger id="user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="RESELLER">Reseller</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {canEditRole && (
            <div className="space-y-1.5">
              <Label>Permissions</Label>
              <div className="space-y-2 rounded-lg border border-border p-3">
                {PERMISSION_FIELDS.map(({ key, label, description }) => (
                  <div key={key} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">{description}</p>
                    </div>
                    <Switch
                      className="shrink-0"
                      checked={permissions.includes(key)}
                      onCheckedChange={(checked) => togglePermission(key, checked)}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {canEditOverselling && (
            <div className="space-y-1.5">
              <Label>Overselling</Label>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Overselling mode</p>
                  <p className="text-xs text-muted-foreground">
                    Allow this reseller&apos;s sub-account quotas to nominally sum above their own limit.
                    Enforcement switches to real aggregate usage across the reseller and their sub-accounts.
                  </p>
                </div>
                <Switch
                  className="shrink-0"
                  checked={oversellingEnabled}
                  onCheckedChange={setOversellingEnabled}
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {QUOTA_FIELDS.map(({ key, label }) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`quota-${key}`}>{label}</Label>
                <Input
                  id={`quota-${key}`}
                  type="number"
                  min={0}
                  value={quotas[key]}
                  onChange={(e) => setQuotas((q) => ({ ...q, [key]: e.target.value }))}
                  placeholder="Unlimited"
                />
              </div>
            ))}
          </div>

          {canReset2FA && (
            <div className="space-y-1.5">
              <Label>Two-factor authentication</Label>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Reset 2FA</p>
                  <p className="text-xs text-muted-foreground">
                    Clears this account&apos;s authenticator and recovery codes. Use when
                    they are locked out.
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setShowResetConfirm(true)}
                  disabled={isResetting}
                >
                  Reset 2FA
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showResetConfirm} onOpenChange={(open) => !isResetting && setShowResetConfirm(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            Reset 2FA for {user?.name}?
          </DialogTitle>
          <DialogDescription>
            This will permanently clear their authenticator secret and all recovery
            codes. They will sign in with password alone until they set 2FA up again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setShowResetConfirm(false)} disabled={isResetting}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={() => void handleReset2FA()} disabled={isResetting}>
            {isResetting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Reset 2FA
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
