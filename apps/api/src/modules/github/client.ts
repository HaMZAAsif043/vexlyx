import { createGitHubAppJwt } from "./tokens.js";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/** Timeout for general API reads, including paged repository/installation lists. */
const API_TIMEOUT_MS = 15_000;
/** Timeout for short token-minting and OAuth code-exchange calls. */
const TOKEN_MINT_TIMEOUT_MS = 10_000;
/**
 * Safety bound when paging /user/installations (per_page=100, so this caps at
 * MAX_INSTALLATION_PAGES * 100 installations). Guards against a malformed
 * Link header causing an unbounded loop; the real stop condition is either a
 * match or the absence of a rel="next" link.
 */
const MAX_INSTALLATION_PAGES = 50;

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code = "GITHUB_API_ERROR",
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

interface GitHubAccount {
  id: number;
  login: string;
  type: "User" | "Organization";
}

export interface GitHubInstallationResponse {
  id: number;
  account: GitHubAccount;
  repository_selection: "all" | "selected";
  suspended_at: string | null;
}

export interface GitHubRepositoryResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  archived: boolean;
  default_branch: string;
  clone_url: string;
  updated_at: string | null;
}

interface RequestOptions extends RequestInit {
  token?: string;
  /** Override the default outbound timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Wraps a fetch timeout/abort into a typed GitHubApiError so callers can
 * distinguish "GitHub never answered" from a genuine HTTP error status.
 */
function throwIfTimeout(error: unknown, timeoutMs: number): void {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    throw new GitHubApiError(
      `GitHub did not respond within ${timeoutMs}ms`,
      504,
      "GITHUB_API_TIMEOUT",
    );
  }
}

async function githubRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, headers, timeoutMs = API_TIMEOUT_MS, ...requestOptions } = options;
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      ...requestOptions,
      signal: requestOptions.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch (error) {
    throwIfTimeout(error, timeoutMs);
    throw error;
  }

  if (!response.ok) {
    throw new GitHubApiError(`GitHub request failed with status ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

/**
 * Extracts the path of the rel="next" page from a GitHub Link header, e.g.
 * `<https://api.github.com/user/installations?per_page=100&page=2>; rel="next", ...`.
 * Returns null when there is no next page.
 */
function extractNextPath(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** Like githubRequest, but also surfaces the next-page path from the Link header. */
async function githubRequestWithHeaders<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; nextPath: string | null }> {
  const { token, headers, timeoutMs = API_TIMEOUT_MS, ...requestOptions } = options;
  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      ...requestOptions,
      signal: requestOptions.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch (error) {
    throwIfTimeout(error, timeoutMs);
    throw error;
  }

  if (!response.ok) {
    throw new GitHubApiError(`GitHub request failed with status ${response.status}`, response.status);
  }

  return {
    data: (await response.json()) as T,
    nextPath: extractNextPath(response.headers.get("link")),
  };
}

export class GitHubClient {
  async getApp(appId: bigint, privateKey: string) {
    return githubRequest<{ id: number; slug: string; client_id: string }>("/app", {
      token: createGitHubAppJwt(appId, privateKey),
    });
  }

  async convertManifest(code: string) {
    return githubRequest<{
      id: number;
      slug: string;
      client_id: string;
      client_secret: string;
      pem: string;
      webhook_secret: string;
    }>(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
  }

  async exchangeUserCode(clientId: string, clientSecret: string, code: string) {
    let response: Response;
    try {
      response = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
        signal: AbortSignal.timeout(TOKEN_MINT_TIMEOUT_MS),
      });
    } catch (error) {
      throwIfTimeout(error, TOKEN_MINT_TIMEOUT_MS);
      throw error;
    }
    if (!response.ok) throw new GitHubApiError("GitHub authorization failed", response.status);
    const body = await response.json() as { access_token?: string; error?: string };
    if (!body.access_token) throw new GitHubApiError("GitHub authorization did not return an access token", 401);
    return body.access_token;
  }

  /**
   * Lists every installation visible to the user token, following the Link
   * header across pages so an account with more than 100 installations is not
   * silently truncated to the first page.
   */
  async listUserInstallations(userToken: string) {
    const installations: GitHubInstallationResponse[] = [];
    let path: string | null = "/user/installations?per_page=100";
    let pages = 0;
    while (path && pages < MAX_INSTALLATION_PAGES) {
      const response: {
        data: { installations: GitHubInstallationResponse[] };
        nextPath: string | null;
      } = await githubRequestWithHeaders<{ installations: GitHubInstallationResponse[] }>(path, {
        token: userToken,
      });
      installations.push(...response.data.installations);
      path = response.nextPath;
      pages += 1;
    }
    return { installations };
  }

  async getInstallation(appId: bigint, privateKey: string, installationId: bigint) {
    return githubRequest<GitHubInstallationResponse>(`/app/installations/${installationId}`, {
      token: createGitHubAppJwt(appId, privateKey),
    });
  }

  async createInstallationToken(appId: bigint, privateKey: string, installationId: bigint) {
    return githubRequest<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", token: createGitHubAppJwt(appId, privateKey) },
    );
  }

  async listRepositories(token: string, page: number, perPage: number) {
    return githubRequest<{ total_count: number; repositories: GitHubRepositoryResponse[] }>(
      `/installation/repositories?page=${page}&per_page=${perPage}`,
      { token },
    );
  }

  async getRepository(token: string, owner: string, repository: string) {
    return githubRequest<GitHubRepositoryResponse>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      { token },
    );
  }

  async listBranches(token: string, owner: string, repository: string, page = 1) {
    return githubRequest<Array<{ name: string; protected: boolean }>>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches?per_page=100&page=${page}`,
      { token },
    );
  }
}
