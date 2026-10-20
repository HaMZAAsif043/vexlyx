"use client";

import { Pencil, Trash2, Users as UsersIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/datetime";
import { useTimezone } from "@/hooks/useSystemSettings";
import type { UserResponse, Role } from "@vexlyx/shared";

interface UserListProps {
  users: UserResponse[];
  isLoading: boolean;
  currentUserId: string;
  isAdmin: boolean;
  onEdit: (user: UserResponse) => void;
  onDelete: (user: UserResponse) => void;
}

const ROLE_VARIANT: Record<Role, "default" | "secondary" | "outline"> = {
  ADMIN: "default",
  RESELLER: "outline",
  USER: "secondary",
};

function formatQuota(value: number | null): string {
  return value === null ? "Unlimited" : String(value);
}

export function UserList({ users, isLoading, currentUserId, isAdmin, onEdit, onDelete }: UserListProps) {
  const timezone = useTimezone();

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <UsersIcon className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium">No sub-accounts yet</p>
        <p className="text-xs text-muted-foreground">Create one to get started.</p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Quotas</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => {
          // ADMIN manages everyone; RESELLER manages only their own
          // sub-accounts (never themselves, another reseller, or an admin).
          const canManage = isAdmin || u.resellerId === currentUserId;

          return (
            <TableRow key={u.id}>
              <TableCell>
                <div className="text-sm font-medium">{u.name}</div>
                <div className="text-xs text-muted-foreground">{u.email}</div>
              </TableCell>
              <TableCell>
                <Badge variant={ROLE_VARIANT[u.role]}>{u.role}</Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <div>Projects: {formatQuota(u.maxProjects)}</div>
                <div>Domains: {formatQuota(u.maxDomains)}</div>
                <div>Databases: {formatQuota(u.maxDatabases)}</div>
                <div>Mailboxes: {formatQuota(u.maxMailboxes)}</div>
                <div>Scheduled tasks: {formatQuota(u.maxScheduledTasks)}</div>
                {u.role === "RESELLER" && <div>Sub-accounts: {formatQuota(u.maxSubAccounts)}</div>}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(u.createdAt, timezone)}
              </TableCell>
              <TableCell className="text-right">
                {canManage && (
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => onEdit(u)}
                      aria-label="Edit user"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      disabled={u.id === currentUserId}
                      onClick={() => onDelete(u)}
                      aria-label="Delete user"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
