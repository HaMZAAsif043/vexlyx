import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Project } from "@vexlyx/shared";
import { ContainerControls } from "./ContainerControls";

// The badge is derived from the polled status, so the test drives that hook
// directly instead of stubbing fetch.
const { status, refetchStatus } = vi.hoisted(() => ({
  status: vi.fn(),
  refetchStatus: vi.fn(),
}));

vi.mock("@/hooks/useDeploy", () => ({
  useContainerAction: () => ({ executeAction: vi.fn(), isExecuting: false }),
  useContainerStatus: () => ({ status: status(), isLoading: false, refetch: refetchStatus }),
}));

vi.mock("@/hooks/useLogs", () => ({
  useRuntimeLogs: () => ({ lines: [], isConnected: false, clear: vi.fn() }),
}));

vi.mock("@/hooks/useDomains", () => ({
  useDomains: () => ({ domains: [] }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const project: Project = {
  id: "p1",
  name: "ideact",
  type: "NODEJS",
  status: "ACTIVE",
  gitUrl: null,
  branch: "main",
  installCmd: null,
  buildCmd: null,
  startCmd: null,
  port: null,
  userId: "u1",
  containerId: "abc123def456",
  containerStatus: "running",
  internalPort: 3000,
  deployedDomain: "ideact.example.test",
  deployedAt: null,
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
};

function containerHealth(health: string | null, state = "running") {
  status.mockReturnValue({ containerStatus: state, containerHealth: health, containerId: "abc123" });
}

beforeEach(() => {
  vi.resetAllMocks();
  containerHealth("healthy");
});

describe("ContainerControls health badge (#202)", () => {
  it("replaces Running when Docker reports a failing healthcheck", () => {
    containerHealth("unhealthy");
    render(<ContainerControls project={project} />);

    expect(screen.getByText("Unhealthy")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("explains what a failing healthcheck means for the domain", () => {
    containerHealth("unhealthy");
    render(<ContainerControls project={project} />);

    expect(screen.getByText("Healthcheck failing.")).toBeTruthy();
    expect(screen.getByText(/502/)).toBeTruthy();
  });

  it("keeps Stop available — an unhealthy container still has to be stoppable", () => {
    containerHealth("unhealthy");
    render(<ContainerControls project={project} />);

    expect(screen.getByRole("button", { name: /stop/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart/i })).toBeTruthy();
  });

  it("shows Running once the probe passes", () => {
    containerHealth("healthy");
    render(<ContainerControls project={project} />);

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Unhealthy")).toBeNull();
    expect(screen.queryByText("Healthcheck failing.")).toBeNull();
  });

  it("names the start period separately from a failure", () => {
    containerHealth("starting");
    render(<ContainerControls project={project} />);

    expect(screen.getByText("Waiting for healthcheck")).toBeTruthy();
    expect(screen.queryByText("Unhealthy")).toBeNull();
  });

  it("says nothing about health for an image that declares no healthcheck", () => {
    containerHealth(null);
    render(<ContainerControls project={project} />);

    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText("Unhealthy")).toBeNull();
    expect(screen.queryByText("Waiting for healthcheck")).toBeNull();
  });

  it("does not call a stopped container unhealthy", () => {
    containerHealth("unhealthy", "exited");
    render(<ContainerControls project={project} />);

    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.queryByText("Unhealthy")).toBeNull();
  });

  it("falls back to the stored status while the first poll is pending", () => {
    status.mockReturnValue(null);
    render(<ContainerControls project={{ ...project, containerStatus: "exited" }} />);

    expect(screen.getByText("Stopped")).toBeTruthy();
  });
});
