import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError, GitHubClient } from "./client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHubClient.listUserInstallations pagination", () => {
  it("returns the first page when there is no next link", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ installations: [{ id: 1 }, { id: 2 }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient();
    const result = await client.listUserInstallations("token");
    expect(result.installations.map((i) => i.id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows the Link rel=next header across pages", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      if (parsed.searchParams.get("page") === "2") {
        return jsonResponse(
          { installations: [{ id: 3 }] },
          { headers: { Link: '<https://api.github.com/user/installations?per_page=100&page=3>; rel="last"' } },
        );
      }
      return jsonResponse(
        { installations: [{ id: 1 }, { id: 2 }] },
        { headers: { Link: '<https://api.github.com/user/installations?per_page=100&page=2>; rel="next"' } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient();
    const result = await client.listUserInstallations("token");
    expect(result.installations.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("GitHubClient outbound timeouts", () => {
  it("maps an aborted request to a typed GITHUB_API_TIMEOUT error", async () => {
    const timeoutError = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });
    const controller = new AbortController();
    controller.abort(timeoutError);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutError; }));

    const client = new GitHubClient();
    // getRepository goes through githubRequest, which applies AbortSignal.timeout.
    await expect(client.getRepository("token", "o", "r")).rejects.toMatchObject({
      code: "GITHUB_API_TIMEOUT",
      statusCode: 504,
    });
  });

  it("passes a timeout signal to fetch for API reads", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ id: 1, name: "r" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new GitHubClient();
    await client.getRepository("token", "o", "r");
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps an aborted token exchange to GITHUB_API_TIMEOUT", async () => {
    const timeoutError = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const controller = new AbortController();
    controller.abort(timeoutError);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutError; }));

    const client = new GitHubClient();
    await expect(client.exchangeUserCode("id", "secret", "code")).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});

it("returns branches from subsequent pages", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(jsonResponse([{ name: "first" }], { headers: { Link: '<https://api.github.com/repos/o/r/branches?page=2>; rel="next"' } }))
    .mockResolvedValueOnce(jsonResponse([{ name: "later" }])));
  expect((await new GitHubClient().listBranches("token", "o", "r")).map(branch => branch.name)).toEqual(["first", "later"]);
});

it("fails explicitly rather than authorizing from an incomplete installation list", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ installations: [] }, {
    headers: { Link: '<https://api.github.com/user/installations?page=2>; rel="next"' },
  })));
  await expect(new GitHubClient().listUserInstallations("token")).rejects.toMatchObject({ code: "GITHUB_API_PAGINATION_LIMIT" });
});

it("maps a deadline reached while reading the response body", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    headers: new Headers(),
    json: async () => {
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      throw controller.signal.reason;
    },
  })));
  await expect(new GitHubClient().getRepository("token", "o", "r")).rejects.toMatchObject({ code: "GITHUB_API_TIMEOUT", statusCode: 504 });
});
