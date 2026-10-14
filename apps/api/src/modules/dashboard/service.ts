import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type { ActivityItem, DashboardSummaryResponse, ServerMetrics } from "@vexlyx/shared";
import { getUsageSummary } from "../../utils/quota.js";
import { MonitoringService } from "../monitoring/service.js";
import { SslService } from "../domains/ssl-service.js";

const ACTIVITY_LIMIT = 15;
const RECENT_DEPLOYMENTS_TAKE = 10;
const RECENT_BACKUPS_TAKE = 5;

export class DashboardService {
  private readonly monitoringService: MonitoringService;
  private readonly sslService: SslService;

  constructor(
    private readonly prisma: PrismaClient,
    logger: FastifyBaseLogger,
  ) {
    this.monitoringService = new MonitoringService(prisma, logger);
    this.sslService = new SslService(prisma);
  }

  async getSummary(userId: string): Promise<DashboardSummaryResponse> {
    const [usage, serverMetrics, sources] = await Promise.all([
      getUsageSummary(this.prisma, userId),
      this.safeGetServerMetrics(),
      this.gatherActivitySources(userId),
    ]);

    const activity = [...sources.deployments, ...sources.backups, ...sources.sslAlerts]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, ACTIVITY_LIMIT);

    return {
      stats: {
        projects: usage.project,
        domains: usage.domain,
        databases: usage.database,
        mailboxes: usage.mailbox,
      },
      serverMetrics,
      activity,
      // Counted from the full alert list, not the capped/merged feed, so it
      // stays accurate even when SSL alerts get pushed out of the top 15.
      sslExpiringCount: sources.sslAlerts.length,
    };
  }

  private async safeGetServerMetrics(): Promise<ServerMetrics | null> {
    try {
      return await this.monitoringService.getServerMetrics();
    } catch {
      // Monitoring script unavailable — degrade gracefully rather than
      // failing the whole dashboard over a monitoring hiccup.
      return null;
    }
  }

  private async gatherActivitySources(userId: string): Promise<{
    deployments: ActivityItem[];
    backups: ActivityItem[];
    sslAlerts: ActivityItem[];
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const isAdmin = user?.role === "ADMIN";

    const [deployments, backups, sslAlerts] = await Promise.all([
      this.recentDeployments(userId),
      isAdmin ? this.recentBackups() : Promise.resolve([]),
      this.recentSslAlerts(userId),
    ]);

    return { deployments, backups, sslAlerts };
  }

  private async recentDeployments(userId: string): Promise<ActivityItem[]> {
    const deployments = await this.prisma.deployment.findMany({
      where: { project: { userId } },
      orderBy: { createdAt: "desc" },
      take: RECENT_DEPLOYMENTS_TAKE,
      include: { project: { select: { id: true, name: true } } },
    });

    return deployments.map((d) => ({
      id: d.id,
      type: "deployment" as const,
      title: `${d.project.name} deployed`,
      description: d.commitMsg ?? d.commitHash ?? null,
      status: d.status,
      timestamp: d.createdAt.toISOString(),
      href: `/projects/${d.project.id}?tab=deploy`,
    }));
  }

  private async recentBackups(): Promise<ActivityItem[]> {
    const backups = await this.prisma.backupSnapshot.findMany({
      orderBy: { createdAt: "desc" },
      take: RECENT_BACKUPS_TAKE,
    });

    return backups.map((b) => ({
      id: b.id,
      type: "backup" as const,
      title: `Backup (${b.trigger.toLowerCase()})`,
      description: null,
      status: b.status,
      timestamp: b.createdAt.toISOString(),
      href: "/backups",
    }));
  }

  private async recentSslAlerts(userId: string): Promise<ActivityItem[]> {
    // Reuses SslService's existing expiry-audit logic (it also refreshes
    // cert status as a side effect) rather than reimplementing days-remaining math.
    // The service scopes the audit to this user's own domains.
    const { alerts } = await this.sslService.checkExpiryAlerts(userId);

    return alerts.map((a) => ({
      id: `ssl-${a.domainId}`,
      type: "ssl_alert" as const,
      title: `SSL ${a.status === "EXPIRED" ? "expired" : "expiring soon"}: ${a.hostname}`,
      description: a.daysRemaining !== null ? `${a.daysRemaining} day(s) remaining` : null,
      status: a.status,
      // SSL alerts have no natural "event time" — use now() so an active
      // alert always surfaces near the top of the feed while it's active.
      timestamp: new Date().toISOString(),
      href: `/domains/${a.domainId}/ssl`,
    }));
  }
}
