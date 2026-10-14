"use client";

import { useEffect } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { FolderKanban, Globe, Database, Mail, ShieldAlert } from "lucide-react";
import { StatCard } from "@/components/dashboard/StatCard";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { ResourceUsageWidget } from "@/components/dashboard/ResourceUsageWidget";
import { RecentActivityFeed } from "@/components/dashboard/RecentActivityFeed";
import { useAuth } from "@/hooks/useAuth";
import { useDashboardSummary } from "@/hooks/useDashboardSummary";
import { cn } from "@/lib/utils";

/**
 * Dashboard home page content (F5.16) — real stat counts, server health,
 * recent activity, and quick actions, fetched via useDashboardSummary().
 */
export function DashboardOverview() {
  const { stats, serverMetrics, activity, sslExpiringCount, isLoading, isError, refetch } =
    useDashboardSummary();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    if (isError) toast.error("Failed to load dashboard data");
  }, [isError]);

  const showGettingStarted = !isLoading && stats?.projects.used === 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground">Overview of your hosting environment.</p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Projects"
          value={String(stats?.projects.used ?? 0)}
          icon={FolderKanban}
          isLoading={isLoading}
          usage={stats?.projects}
        />
        <StatCard
          title="Domains"
          value={String(stats?.domains.used ?? 0)}
          icon={Globe}
          isLoading={isLoading}
          usage={stats?.domains}
        />
        <StatCard
          title="Databases"
          value={String(stats?.databases.used ?? 0)}
          icon={Database}
          isLoading={isLoading}
          usage={stats?.databases}
        />
        <StatCard
          title="Mailboxes"
          value={String(stats?.mailboxes.used ?? 0)}
          icon={Mail}
          isLoading={isLoading}
          usage={stats?.mailboxes}
        />
      </div>

      {!isLoading && sslExpiringCount > 0 && (
        <Link
          href="/domains"
          className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 transition-colors hover:bg-amber-500/15 dark:text-amber-400"
        >
          <ShieldAlert className="h-4 w-4 shrink-0" />
          {sslExpiringCount} SSL certificate{sslExpiringCount === 1 ? "" : "s"} expiring soon or
          expired — review domains
        </Link>
      )}

      <QuickActions />

      <div className={cn("grid items-start gap-6", isAdmin && "lg:grid-cols-2")}>
        {isAdmin && (
          <ResourceUsageWidget
            serverMetrics={serverMetrics}
            isLoading={isLoading}
            onRefresh={async () => refetch()}
          />
        )}
        <RecentActivityFeed activity={activity} isLoading={isLoading} />
      </div>

      {showGettingStarted && (
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="text-lg font-semibold">Getting Started</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Welcome to Vexlyx. Create your first project to get started with deploying
            applications.
          </p>
        </div>
      )}
    </div>
  );
}
