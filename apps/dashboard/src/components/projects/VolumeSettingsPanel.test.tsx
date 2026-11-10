import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@vexlyx/shared";
import { VolumeSettingsPanel } from "./VolumeSettingsPanel";
const { fetchAPI } = vi.hoisted(() => ({ fetchAPI: vi.fn() }));
vi.mock("@/lib/api", () => ({ fetchAPI }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  vi.resetAllMocks();
  fetchAPI.mockResolvedValue({});
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

it("saves only named-volume paths without overwriting other settings", async () => {
  render(
    <VolumeSettingsPanel
      project={{ ...project, type: "DOCKER", volumePaths: ["/data"] }}
    />,
  );
  const field = screen.getByLabelText("Container directories, one per line");
  await userEvent.clear(field);
  await userEvent.type(field, "/uploads");
  await userEvent.click(screen.getByText("Save volume paths"));
  await waitFor(() => expect(fetchAPI).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchAPI.mock.calls[0]![1].body)).toEqual({
    volumePaths: ["/uploads"],
  });
});
it("rejects an unsafe container mount before sending a request", async () => {
  render(<VolumeSettingsPanel project={{ ...project, type: "DOCKER" }} />);
  await userEvent.type(
    screen.getByLabelText("Container directories, one per line"),
    "/data:ro",
  );
  await userEvent.click(screen.getByText("Save volume paths"));
  expect(fetchAPI).not.toHaveBeenCalled();
});
it("hides volumes for other project types", () => {
  render(<VolumeSettingsPanel project={project} />);
  expect(screen.queryByText("Persistent Docker data")).toBeNull();
});
