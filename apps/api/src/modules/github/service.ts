import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type {
  ConfigureGitHubAppInput,
  GitHubAppStatus,
  GitHubBranch,
  GitHubInstallation,
  GitHubRepositoryList,
  GitHubRepositoryListQuery,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";
import { decrypt, encrypt } from "../../utils/encryption.js";
import type { AuditLogService } from "../audit-log/service.js";
import { GitHubApiError, GitHubClient, type GitHubInstallationResponse } from "./client.js";

const APP_ID = "singleton";
const STATE_TTL_SECONDS = 600;

interface StatePayload {
  userId: string;
  sessionId: string;
  purpose: "manifest" | "installation";
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const installationTokens = new Map<string, CachedToken>();

export async function getGitHubInstallationToken(
  prisma: PrismaClient,
  installationId: bigint,
  client = new GitHubClient(),
): Promise<string> {
  const key = installationId.toString();
  const cached = installationTokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 300_000) return cached.token;
  const app = await prisma.gitHubApp.findUnique({ where: { id: APP_ID } });
  if (!app) throw new GitHubError("GitHub App is not configured", "GITHUB_APP_NOT_CONFIGURED", 409);
  const result = await client.createInstallationToken(app.appId, decrypt(app.encryptedPrivateKey), installationId);
  installationTokens.set(key, { token: result.token, expiresAt: new Date(result.expires_at).getTime() });
  return result.token;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubService {
  constructor(
    private prisma: PrismaClient,
    private redis: Redis,
    private auditLog: AuditLogService,
    private client = new GitHubClient(),
  ) {}

  async getAppStatus(): Promise<GitHubAppStatus> {
    const app = await this.prisma.gitHubApp.findUnique({ where: { id: APP_ID } });
    const readiness = this.publicUrlReadiness();
    return {
      configured: Boolean(app),
      appId: app?.appId.toString() ?? null,
      slug: app?.slug ?? null,
      clientId: app?.clientId ?? null,
      ...readiness,
    };
  }

  async createManifest(userId: string, sessionId: string) {
    this.requirePublicUrl();
    const state = await this.issueState({ userId, sessionId, purpose: "manifest" });
    const callbackUrl = `${env.API_BASE_URL}/api/github/installations/callback`;
    const manifestCallbackUrl = `${env.API_BASE_URL}/api/github/app/manifest/callback`;
    const panelHost = new URL(env.API_BASE_URL).hostname;
    return {
      url: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest: {
        name: `Vexlyx (${panelHost})`,
        url: env.CORS_ORIGIN,
        redirect_url: manifestCallbackUrl,
        callback_urls: [callbackUrl],
        public: true,
        request_oauth_on_install: true,
        hook_attributes: { url: `${env.API_BASE_URL}/api/webhooks/github-app`, active: true },
        default_permissions: { contents: "read", metadata: "read" },
        default_events: ["push"],
      },
    };
  }

  async completeManifest(userId: string, sessionId: string, state: string, code: string) {
    await this.consumeState(state, { userId, sessionId, purpose: "manifest" });
    const converted = await this.client.convertManifest(code);
    return this.saveApp(userId, {
      appId: String(converted.id),
      slug: converted.slug,
      clientId: converted.client_id,
      clientSecret: converted.client_secret,
      privateKey: converted.pem,
      webhookSecret: converted.webhook_secret,
    });
  }

  async configureApp(userId: string, input: ConfigureGitHubAppInput) {
    const appId = BigInt(input.appId);
    const verified = await this.client.getApp(appId, input.privateKey);
    if (verified.id.toString() !== input.appId) {
      throw new GitHubError("The GitHub App credentials do not match the App ID", "GITHUB_APP_MISMATCH", 422);
    }
    return this.saveApp(userId, { ...input, slug: verified.slug, clientId: verified.client_id });
  }

  async createInstallationUrl(userId: string, sessionId: string) {
    const app = await this.requireApp();
    const state = await this.issueState({ userId, sessionId, purpose: "installation" });
    return { url: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new?state=${encodeURIComponent(state)}` };
  }

  async completeInstallation(
    userId: string,
    sessionId: string,
    state: string,
    code: string,
    installationId: string,
  ): Promise<GitHubInstallation> {
    await this.consumeState(state, { userId, sessionId, purpose: "installation" });
    const app = await this.requireApp();
    const userToken = await this.client.exchangeUserCode(app.clientId, decrypt(app.encryptedClientSecret), code);
    const accessible = await this.client.listUserInstallations(userToken);
    const authorized = accessible.installations.some((item) => String(item.id) === installationId);
    if (!authorized) {
      await this.auditLog.log(userId, "github.installation_link_rejected", { type: "GitHubInstallation", id: installationId }, { after: { reason: "ownership_mismatch" } });
      throw new GitHubError("The GitHub installation does not belong to the authorized account", "GITHUB_INSTALLATION_MISMATCH", 403);
    }

    const authoritative = await this.client.getInstallation(app.appId, decrypt(app.encryptedPrivateKey), BigInt(installationId));
    const data = this.installationData(authoritative);
    // Ownership belongs in the write predicate: a prior read cannot prevent
    // concurrent callbacks from linking the same installation to different users.
    const record = await this.prisma.gitHubInstallation.upsert({
      where: { installationId: BigInt(installationId), userId },
      create: { ...data, userId },
      update: { ...data, disconnectedAt: null },
    }).catch((err: unknown) => {
      if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
        throw new GitHubError("This GitHub installation is already linked", "GITHUB_INSTALLATION_ALREADY_LINKED", 409);
      }
      throw err;
    });
    await this.auditLog.log(userId, "github.installation_linked", { type: "GitHubInstallation", id: record.id }, { after: { accountLogin: record.accountLogin } });
    return this.serializeInstallation(record);
  }

  async listInstallations(userId: string): Promise<GitHubInstallation[]> {
    const records = await this.prisma.gitHubInstallation.findMany({ where: { userId }, orderBy: { accountLogin: "asc" } });
    return records.map((record) => this.serializeInstallation(record));
  }

  async disconnectInstallation(userId: string, id: string): Promise<void> {
    const installation = await this.findOwnedInstallation(userId, id);
    await this.prisma.$transaction([
      this.prisma.gitHubInstallation.update({
        where: { id },
        data: { status: "DISCONNECTED", disconnectedAt: new Date() },
      }),
      this.prisma.project.updateMany({
        where: { githubInstallationId: id },
        data: { githubConnectionStatus: "DISCONNECTED", githubDisconnectReason: "Installation disconnected from Vexlyx" },
      }),
    ]);
    installationTokens.delete(installation.installationId.toString());
    await this.auditLog.log(userId, "github.installation_unlinked", { type: "GitHubInstallation", id }, { after: { accountLogin: installation.accountLogin } });
  }

  async listRepositories(userId: string, id: string, query: GitHubRepositoryListQuery): Promise<GitHubRepositoryList> {
    const installation = await this.requireActiveInstallation(userId, id);
    const token = await this.getInstallationToken(installation.installationId);
    const search = query.search?.toLowerCase();
    const firstPage = search ? 1 : query.page;
    const pageSize = search ? 100 : query.perPage;
    const first = await this.client.listRepositories(token, firstPage, pageSize);
    const allRepositories = [...first.repositories];
    if (search) {
      const pageCount = Math.min(10, Math.ceil(first.total_count / pageSize));
      for (let page = 2; page <= pageCount; page += 1) {
        const response = await this.client.listRepositories(token, page, pageSize);
        allRepositories.push(...response.repositories);
      }
    }
    const repositories = allRepositories
      .filter((repository) => !search || repository.full_name.toLowerCase().includes(search))
      .slice(search ? (query.page - 1) * query.perPage : 0, search ? query.page * query.perPage : undefined)
      .map((repository) => ({
        id: String(repository.id),
        name: repository.name,
        fullName: repository.full_name,
        private: repository.private,
        archived: repository.archived,
        defaultBranch: repository.default_branch,
        updatedAt: repository.updated_at,
      }));
    const totalCount = search
      ? allRepositories.filter((repository) => repository.full_name.toLowerCase().includes(search)).length
      : first.total_count;
    return { repositories, totalCount, page: query.page, perPage: query.perPage };
  }

  async listBranches(userId: string, id: string, repositoryId: string): Promise<GitHubBranch[]> {
    const installation = await this.requireActiveInstallation(userId, id);
    const repository = await this.findRepository(installation.installationId, repositoryId);
    const [owner, name] = repository.full_name.split("/");
    if (!owner || !name) throw new GitHubError("Invalid repository name", "GITHUB_REPOSITORY_INVALID", 422);
    const token = await this.getInstallationToken(installation.installationId);
    return this.client.listBranches(token, owner, name);
  }

  async findRepository(installationId: bigint, repositoryId: string) {
    const token = await this.getInstallationToken(installationId);
    let page = 1;
    while (page <= 10) {
      const response = await this.client.listRepositories(token, page, 100);
      const repository = response.repositories.find((item) => String(item.id) === repositoryId);
      if (repository) return repository;
      if (page * 100 >= response.total_count) break;
      page += 1;
    }
    throw new GitHubError("Repository is not accessible through this installation", "GITHUB_REPOSITORY_NOT_FOUND", 404);
  }

  async getOwnedInstallationRecord(userId: string, id: string) {
    return this.requireActiveInstallation(userId, id);
  }

  async getInstallationToken(installationId: bigint): Promise<string> {
    try {
      return await getGitHubInstallationToken(this.prisma, installationId, this.client);
    } catch (error) {
      if (error instanceof GitHubApiError) throw new GitHubError("Unable to authenticate the GitHub installation", "GITHUB_INSTALLATION_AUTH_FAILED", error.statusCode);
      throw error;
    }
  }

  private async saveApp(userId: string, input: ConfigureGitHubAppInput) {
    const existed = Boolean(await this.prisma.gitHubApp.findUnique({ where: { id: APP_ID }, select: { id: true } }));
    const app = await this.prisma.gitHubApp.upsert({
      where: { id: APP_ID },
      create: {
        id: APP_ID,
        appId: BigInt(input.appId),
        slug: input.slug,
        clientId: input.clientId,
        encryptedClientSecret: encrypt(input.clientSecret),
        encryptedPrivateKey: encrypt(input.privateKey),
        encryptedWebhookSecret: encrypt(input.webhookSecret),
      },
      update: {
        appId: BigInt(input.appId),
        slug: input.slug,
        clientId: input.clientId,
        encryptedClientSecret: encrypt(input.clientSecret),
        encryptedPrivateKey: encrypt(input.privateKey),
        encryptedWebhookSecret: encrypt(input.webhookSecret),
      },
    });
    installationTokens.clear();
    await this.auditLog.log(userId, existed ? "github.app_replaced" : "github.app_created", { type: "GitHubApp", id: APP_ID }, { after: { appId: app.appId.toString(), slug: app.slug } });
    return this.getAppStatus();
  }

  private async requireApp() {
    const app = await this.prisma.gitHubApp.findUnique({ where: { id: APP_ID } });
    if (!app) throw new GitHubError("GitHub App is not configured", "GITHUB_APP_NOT_CONFIGURED", 409);
    return app;
  }

  private async findOwnedInstallation(userId: string, id: string) {
    const installation = await this.prisma.gitHubInstallation.findUnique({ where: { id } });
    if (!installation) throw new GitHubError("GitHub installation not found", "GITHUB_INSTALLATION_NOT_FOUND", 404);
    if (installation.userId !== userId) throw new GitHubError("GitHub installation not found", "GITHUB_INSTALLATION_NOT_FOUND", 404);
    return installation;
  }

  private async requireActiveInstallation(userId: string, id: string) {
    const installation = await this.findOwnedInstallation(userId, id);
    if (installation.status !== "CONNECTED") throw new GitHubError("GitHub installation is not connected", "GITHUB_INSTALLATION_INACTIVE", 409);
    return installation;
  }

  private installationData(installation: GitHubInstallationResponse) {
    return {
      installationId: BigInt(installation.id),
      accountId: BigInt(installation.account.id),
      accountLogin: installation.account.login,
      accountType: installation.account.type,
      repositorySelection: installation.repository_selection,
      status: installation.suspended_at ? "SUSPENDED" as const : "CONNECTED" as const,
      suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    };
  }

  private serializeInstallation(record: Awaited<ReturnType<GitHubService["findOwnedInstallation"]>>): GitHubInstallation {
    return {
      id: record.id,
      installationId: record.installationId.toString(),
      accountId: record.accountId.toString(),
      accountLogin: record.accountLogin,
      accountType: record.accountType as "User" | "Organization",
      repositorySelection: record.repositorySelection as "all" | "selected",
      status: record.status,
      suspendedAt: record.suspendedAt?.toISOString() ?? null,
      disconnectedAt: record.disconnectedAt?.toISOString() ?? null,
    };
  }

  private async issueState(payload: StatePayload): Promise<string> {
    const state = randomBytes(32).toString("hex");
    await this.redis.set(`github:state:${state}`, JSON.stringify(payload), "EX", STATE_TTL_SECONDS, "NX");
    return state;
  }

  private async consumeState(state: string, expected: StatePayload): Promise<void> {
    const key = `github:state:${state}`;
    const raw = await this.redis.eval(
      "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
      1,
      key,
    ) as string | null;
    if (!raw) throw new GitHubError("GitHub authorization state is invalid or expired", "GITHUB_STATE_INVALID", 400);
    const actual = JSON.parse(raw) as StatePayload;
    if (actual.userId !== expected.userId || actual.sessionId !== expected.sessionId || actual.purpose !== expected.purpose) {
      throw new GitHubError("GitHub authorization state does not match this session", "GITHUB_STATE_MISMATCH", 403);
    }
  }

  private publicUrlReadiness() {
    const url = new URL(env.API_BASE_URL);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname) || url.hostname.endsWith(".localhost");
    const publicUrlReady = url.protocol === "https:" && !local;
    return {
      publicUrlReady,
      publicUrlError: publicUrlReady ? null : "GitHub requires API_BASE_URL to be a public HTTPS URL.",
    };
  }

  private requirePublicUrl() {
    const readiness = this.publicUrlReadiness();
    if (!readiness.publicUrlReady) throw new GitHubError(readiness.publicUrlError!, "GITHUB_PUBLIC_URL_REQUIRED", 409);
  }
}
