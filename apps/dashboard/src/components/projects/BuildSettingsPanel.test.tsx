import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@vexlyx/shared";
import { BuildSettingsPanel } from "./BuildSettingsPanel";

// The component and its tests have to share one ApiRequestError class, or the
// instanceof check in its error handler never matches.
const { fetchAPI, ApiRequestError } = vi.hoisted(() => {
  class ApiRequestError extends Error {}
  return { fetchAPI: vi.fn(), ApiRequestError };
});

vi.mock("@/lib/api", () => ({ fetchAPI, ApiRequestError }));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const project: Project = {
  id: "p1",
  name: "ideact",
  type: "NEXTJS",
  status: "ACTIVE",
  gitUrl: "https://github.com/example/ideact",
  branch: "main",
  installCmd: null,
  buildCmd: null,
  startCmd: null,
  port: null,
  userId: "u1",
  containerId: null,
  containerStatus: null,
  internalPort: null,
  deployedDomain: null,
  deployedAt: null,
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
};

function renderPanel(over: Partial<Project> = {}) {
  render(<BuildSettingsPanel project={{ ...project, ...over }} />);
}

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

/** The body of the PUT to the project — the panel's only write. */
function putBody(): Record<string, unknown> {
  const call = fetchAPI.mock.calls.find(
    ([path, init]) =>
      path === "/api/projects/p1" && (init as RequestInit)?.method === "PUT",
  );
  if (!call) throw new Error("the panel never sent a PUT");
  return JSON.parse(String((call[1] as RequestInit).body));
}

beforeEach(() => {
  vi.resetAllMocks();
  fetchAPI.mockResolvedValue(project);
});

describe("BuildSettingsPanel", () => {
  it("starts with every command blank so auto-detection applies", () => {
    renderPanel();

    expect(field("Install Command").value).toBe("");
    expect(field("Build Command").value).toBe("");
    expect(field("Start Command").value).toBe("");
    expect(screen.queryByText("Custom")).toBeNull();
  });

  it("shows a stored override and marks it custom", () => {
    renderPanel({ installCmd: "npm ci", port: 3000 });

    expect(field("Install Command").value).toBe("npm ci");
    expect(field("Container Port").value).toBe("3000");
    expect(screen.getAllByText("Custom").length).toBe(1);
  });

  it("writes typed overrides and normalises blanks to null", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(field("Install Command"), "npm ci");
    await user.type(field("Container Port"), "3000");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchAPI).toHaveBeenCalled());
    expect(putBody()).toEqual({
      installCmd: "npm ci",
      buildCmd: null,
      startCmd: null,
      port: 3000,
    });
  });

  it("leaves an untouched port out instead of erasing a detected one", async () => {
    const user = userEvent.setup();
    renderPanel({ port: 8080 });

    await user.type(field("Build Command"), "pnpm build");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchAPI).toHaveBeenCalled());
    expect(putBody()).not.toHaveProperty("port");
  });

  it("clears a stored port when the user erases the field", async () => {
    const user = userEvent.setup();
    renderPanel({ port: 8080 });

    await user.clear(field("Container Port"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchAPI).toHaveBeenCalled());
    expect(putBody()).toHaveProperty("port", null);
  });

  it("refuses an out-of-range port without writing", async () => {
    const { toast } = await import("sonner");
    const user = userEvent.setup();
    renderPanel();

    await user.type(field("Container Port"), "99999");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(fetchAPI).not.toHaveBeenCalled();
  });

  it("clears every override back to auto-detection", async () => {
    const user = userEvent.setup();
    renderPanel({
      installCmd: "npm ci",
      buildCmd: "npm run build",
      port: 3000,
    });

    await user.click(screen.getByRole("button", { name: "Auto" }));

    await waitFor(() => expect(fetchAPI).toHaveBeenCalled());
    expect(putBody()).toEqual({
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      port: null,
    });
    expect(field("Install Command").value).toBe("");
    expect(field("Container Port").value).toBe("");
  });

  it("runs detection and offers the detected command as a placeholder", async () => {
    const user = userEvent.setup();
    fetchAPI.mockImplementation((path: string) =>
      path === "/api/projects/p1/build-plan"
        ? Promise.resolve({
            framework: "nextjs",
            detectedType: "NEXTJS",
            installCmd: "pnpm install",
            buildCmd: "pnpm run build",
            startCmd: "pnpm start",
          })
        : Promise.reject(new Error(`unexpected call: ${path}`)),
    );
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Detect" }));

    await waitFor(() =>
      expect(field("Install Command").placeholder).toBe("pnpm install"),
    );
    expect(field("Build Command").placeholder).toBe("pnpm run build");
  });

  it("deploys with the stored settings after saving them", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.type(field("Build Command"), "npm run build");
    await user.click(screen.getByRole("button", { name: "Save & Deploy" }));

    await waitFor(() =>
      expect(fetchAPI).toHaveBeenCalledWith(
        "/api/projects/p1/build",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("surfaces the API's own rejection message", async () => {
    const { toast } = await import("sonner");
    const user = userEvent.setup();
    fetchAPI.mockRejectedValue(
      new ApiRequestError("Port must be a whole number between 1 and 65535"),
    );
    renderPanel();

    await user.type(field("Start Command"), "node server.js");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0]![0]).toBe(
      "Port must be a whole number between 1 and 65535",
    );
  });
});
