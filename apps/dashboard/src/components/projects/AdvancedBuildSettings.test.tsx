import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@vexlyx/shared";
import {
  AdvancedBuildSettings,
  RuntimeVersionSettings,
} from "./AdvancedBuildSettings";
const { fetchAPI } = vi.hoisted(() => ({ fetchAPI: vi.fn() }));
vi.mock("@/lib/api", () => ({ fetchAPI }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  vi.resetAllMocks();
  fetchAPI.mockImplementation(async () => ({ variables: [] }));
});
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

it("writes only the selected runtime variable and leaves other settings untouched", async () => {
  render(<RuntimeVersionSettings projectId="p1" />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Node version") as HTMLSelectElement).disabled,
    ).toBe(false),
  );
  await userEvent.selectOptions(screen.getByLabelText("Node version"), "22");
  await userEvent.click(screen.getByText("Save runtime versions"));
  await waitFor(() =>
    expect(
      fetchAPI.mock.calls.filter(([, options]) => options?.method === "POST"),
    ).toHaveLength(1),
  );
  expect(
    JSON.parse(
      fetchAPI.mock.calls.find(([, options]) => options?.method === "POST")![1]
        .body,
    ),
  ).toEqual({ key: "NIXPACKS_NODE_VERSION", value: "22" });
});
it("loads a custom existing version and clears only that override on Auto", async () => {
  fetchAPI.mockImplementation(async (path: string) =>
    path.endsWith("/reveal")
      ? { value: "22.11.0" }
      : { variables: [{ key: "NIXPACKS_NODE_VERSION" }, { key: "SECRET" }] },
  );
  render(<RuntimeVersionSettings projectId="p1" />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Node version") as HTMLSelectElement).value,
    ).toBe("22.11.0"),
  );
  expect(fetchAPI.mock.calls.some(([path]) => path.includes("SECRET"))).toBe(
    false,
  );
  await userEvent.selectOptions(screen.getByLabelText("Node version"), "");
  await userEvent.click(screen.getByText("Save runtime versions"));
  await waitFor(() =>
    expect(fetchAPI).toHaveBeenCalledWith(
      "/api/projects/p1/env/NIXPACKS_NODE_VERSION",
      { method: "DELETE" },
    ),
  );
});
it("saves build controls independently of commands and environment", async () => {
  render(<AdvancedBuildSettings project={project} />);
  await userEvent.type(screen.getByLabelText("Base directory"), "apps/web");
  await userEvent.type(screen.getByLabelText("Container memory limit"), "1g");
  await userEvent.click(screen.getByLabelText("Enable build cache"));
  await userEvent.click(screen.getByText("Save build controls"));
  await waitFor(() =>
    expect(
      fetchAPI.mock.calls.some(([, options]) => options?.method === "PUT"),
    ).toBe(true),
  );
  expect(
    JSON.parse(
      fetchAPI.mock.calls.find(([, options]) => options?.method === "PUT")![1]
        .body,
    ),
  ).toEqual({
    baseDirectory: "apps/web",
    memoryLimit: "1g",
    buildCacheEnabled: false,
  });
});
it("rejects traversal before saving", async () => {
  render(<AdvancedBuildSettings project={project} />);
  await userEvent.type(screen.getByLabelText("Base directory"), "../other");
  await userEvent.click(screen.getByText("Save build controls"));
  expect(
    fetchAPI.mock.calls.some(([, options]) => options?.method === "PUT"),
  ).toBe(false);
});
it("clears the current project's cache through its authenticated endpoint", async () => {
  render(<AdvancedBuildSettings project={project} />);
  await userEvent.click(screen.getByText("Clear build cache"));
  await waitFor(() =>
    expect(fetchAPI).toHaveBeenCalledWith(
      "/api/projects/p1/build-cache/clear",
      { method: "POST" },
    ),
  );
});
