import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import type {
  FirewallStatusResponse,
  FirewallRuleResponse,
  CreateFirewallRuleInput,
  UpdateFirewallSettingsInput,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import type { AuditLogService } from "../audit-log/service.js";
import { getPythonBin } from "../../utils/pythonBin.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FirewallError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "FirewallError";
  }
}

// ---------------------------------------------------------------------------
// Helper — locate firewall_manager.py (mirrors monitoring/service.ts)
// ---------------------------------------------------------------------------

function getFirewallScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/firewall_manager.py"),
    resolve(currentDir, "../../../../system/python/firewall_manager.py"),
    resolve(process.cwd(), "../../system/python/firewall_manager.py"),
    resolve(process.cwd(), "system/python/firewall_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/firewall_manager.py");
}

// ---------------------------------------------------------------------------
// Helper — run a firewall_manager.py command and resolve the result
// ---------------------------------------------------------------------------

function runFirewallCommand<T>(payload: Record<string, unknown>, logger: FastifyBaseLogger): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const scriptPath = getFirewallScriptPath();
    const body = JSON.stringify({
      sshPort: env.FIREWALL_SSH_PORT,
      panelPort: env.PORT,
      helperImage: env.FIREWALL_HELPER_IMAGE,
      ...payload,
    });

    const pythonBin = getPythonBin();

    const child = spawn(pythonBin, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      logger.error({ err }, "firewall_manager.py spawn error");
      reject(new FirewallError(`Failed to start firewall script: ${err.message}`, "SPAWN_ERROR", 500));
    });

    child.on("close", (code) => {
      if (stderr) {
        logger.debug({ stderr }, "firewall_manager.py stderr output");
      }

      const line = stdout.trim().split("\n").pop() ?? "";
      if (!line) {
        reject(new FirewallError("Firewall script produced no output", "EMPTY_OUTPUT", 500));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        reject(new FirewallError(`Firewall script returned invalid JSON: ${line.slice(0, 100)}`, "INVALID_JSON", 500));
        return;
      }

      if (parsed && typeof parsed === "object" && "error" in parsed && typeof (parsed as Record<string, unknown>).error === "string") {
        const err = parsed as { error: string; code?: string };
        // LOCKOUT_RISK and invalid-payload rejections are user errors (400), everything else is a script/runtime failure (500).
        const statusCode = err.code === "LOCKOUT_RISK" || err.code === "INVALID_PAYLOAD" ? 400 : 500;
        reject(new FirewallError(err.error, err.code ?? "FIREWALL_SCRIPT_ERROR", statusCode));
        return;
      }

      if (code !== 0) {
        reject(new FirewallError(`Firewall script exited with code ${code}`, "SCRIPT_ERROR", 500));
        return;
      }

      resolvePromise(parsed as T);
    });

    child.stdin.write(body);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Live UFW rule shape, as parsed by firewall_manager.py's `status` command
// ---------------------------------------------------------------------------

interface LiveRule {
  port: number;
  protocol: "TCP" | "UDP";
  action: "ALLOW" | "DENY";
  source: string | null;
  comment: string | null;
}

interface LiveStatus {
  active: boolean;
  defaultIncoming: "ALLOW" | "DENY";
  defaultOutgoing: "ALLOW" | "DENY";
  rules: LiveRule[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FirewallService {
  constructor(
    private prisma: PrismaClient,
    private logger: FastifyBaseLogger,
    private auditLog: AuditLogService,
  ) {}

  private getProtectedPorts(): number[] {
    return [env.FIREWALL_SSH_PORT, env.PORT];
  }

  async getSettingsRow() {
    const existing = await this.prisma.firewallSettings.findUnique({ where: { id: "default" } });
    if (existing) return existing;
    return this.prisma.firewallSettings.create({ data: { id: "default" } });
  }

  async getStatus(): Promise<FirewallStatusResponse> {
    const [live, dbRules, settingsRow] = await Promise.all([
      runFirewallCommand<LiveStatus>({ command: "status" }, this.logger),
      this.prisma.firewallRule.findMany({ orderBy: { createdAt: "desc" } }),
      this.getSettingsRow(),
    ]);

    const matchDbRule = (r: LiveRule) =>
      dbRules.find(
        (d) =>
          d.port === r.port &&
          d.protocol === r.protocol &&
          d.action === r.action &&
          (d.source ?? null) === r.source,
      );

    const rules: FirewallRuleResponse[] = live.rules.map((r) => {
      const dbRule = matchDbRule(r);
      if (dbRule) {
        return {
          id: dbRule.id,
          port: dbRule.port,
          protocol: dbRule.protocol,
          source: dbRule.source,
          action: dbRule.action,
          comment: dbRule.comment,
          createdBy: dbRule.createdBy,
          createdAt: dbRule.createdAt.toISOString(),
          managed: true,
        };
      }
      return {
        id: `system:${r.port}-${r.protocol}-${r.action}-${r.source ?? "any"}`,
        port: r.port,
        protocol: r.protocol,
        source: r.source,
        action: r.action,
        comment: r.comment,
        createdBy: null,
        createdAt: null,
        managed: false,
      };
    });

    return {
      active: live.active,
      rules,
      settings: {
        defaultIncoming: live.defaultIncoming,
        defaultOutgoing: live.defaultOutgoing,
        updatedAt: settingsRow.updatedAt.toISOString(),
      },
      protectedPorts: this.getProtectedPorts(),
    };
  }

  async addRule(userId: string, input: CreateFirewallRuleInput): Promise<FirewallRuleResponse> {
    await runFirewallCommand(
      {
        command: "add_rule",
        port: input.port,
        protocol: input.protocol,
        action: input.action,
        source: input.source,
        comment: input.comment,
      },
      this.logger,
    );

    const created = await this.prisma.firewallRule.create({
      data: {
        port: input.port,
        protocol: input.protocol,
        action: input.action,
        source: input.source ?? null,
        comment: input.comment ?? null,
        createdBy: userId,
      },
    });

    await this.auditLog.log(userId, "firewall.rule_created", { type: "FirewallRule", id: created.id }, {
      after: { port: created.port, protocol: created.protocol, action: created.action, source: created.source },
    });

    return {
      id: created.id,
      port: created.port,
      protocol: created.protocol,
      source: created.source,
      action: created.action,
      comment: created.comment,
      createdBy: created.createdBy,
      createdAt: created.createdAt.toISOString(),
      managed: true,
    };
  }

  async deleteRule(userId: string, id: string): Promise<void> {
    const rule = await this.prisma.firewallRule.findUnique({ where: { id } });
    if (!rule) {
      throw new FirewallError("Firewall rule not found", "RULE_NOT_FOUND", 404);
    }

    await runFirewallCommand(
      {
        command: "delete_rule",
        port: rule.port,
        protocol: rule.protocol,
        action: rule.action,
        source: rule.source,
      },
      this.logger,
    );

    await this.prisma.firewallRule.delete({ where: { id } });

    await this.auditLog.log(userId, "firewall.rule_deleted", { type: "FirewallRule", id }, {
      before: { port: rule.port, protocol: rule.protocol, action: rule.action, source: rule.source },
    });
  }

  async updateSettings(userId: string, input: UpdateFirewallSettingsInput) {
    const before = await this.getSettingsRow();

    await runFirewallCommand(
      {
        command: "set_default_policy",
        defaultIncoming: input.defaultIncoming,
        defaultOutgoing: input.defaultOutgoing,
      },
      this.logger,
    );

    const updated = await this.prisma.firewallSettings.upsert({
      where: { id: "default" },
      create: { id: "default", ...input },
      update: input,
    });

    await this.auditLog.log(userId, "firewall.policy_changed", { type: "FirewallSettings", id: "default" }, {
      before: { defaultIncoming: before.defaultIncoming, defaultOutgoing: before.defaultOutgoing },
      after: { defaultIncoming: updated.defaultIncoming, defaultOutgoing: updated.defaultOutgoing },
    });

    return updated;
  }
}
