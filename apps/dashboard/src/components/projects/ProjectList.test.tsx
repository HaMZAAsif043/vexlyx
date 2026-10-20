import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Project } from "@vexlyx/shared";
import { ProjectList } from "./ProjectList";

const project: Project = {
  id: "project-1",
  name: "Example app",
  type: "NEXTJS",
  status: "ACTIVE",
  gitUrl: "https://github.com/example/app",
  branch: "main",
  buildCmd: null,
  startCmd: null,
  port: null,
  userId: "user-1",
  containerId: null,
  containerStatus: null,
  internalPort: null,
  deployedDomain: null,
  deployedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("ProjectList", () => {
  it("renders project cards with their details and navigation links", () => {
    render(
      <ProjectList
        projects={[
          project,
          {
            ...project,
            id: "project-2",
            name: "Worker",
            type: "NODEJS",
            status: "STOPPED",
            gitUrl: null,
          },
        ]}
        isLoading={false}
        onNewProject={vi.fn()}
      />,
    );

    const app = screen.getByRole("link", { name: /Example app/ });
    expect(app.getAttribute("href")).toBe("/projects/project-1");
    expect(within(app).getByText("Next.js")).toBeTruthy();
    expect(within(app).getByText("Active")).toBeTruthy();
    expect(within(app).getByText("github.com/example/app")).toBeTruthy();

    const worker = screen.getByRole("link", { name: /Worker/ });
    expect(worker.getAttribute("href")).toBe("/projects/project-2");
    expect(within(worker).getByText("Stopped")).toBeTruthy();
    expect(within(worker).getByText("No repository connected")).toBeTruthy();
  });

  it("offers project creation when the list is empty", async () => {
    const user = userEvent.setup();
    const onNewProject = vi.fn();
    render(
      <ProjectList
        projects={[]}
        isLoading={false}
        onNewProject={onNewProject}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "No projects yet" }),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "New Project" }));

    expect(onNewProject).toHaveBeenCalledOnce();
  });

  it("keeps the empty state hidden until loading completes", () => {
    const { rerender } = render(
      <ProjectList projects={[]} isLoading onNewProject={vi.fn()} />,
    );

    expect(screen.queryByText("No projects yet")).toBeNull();
    expect(screen.queryByRole("button", { name: "New Project" })).toBeNull();

    rerender(
      <ProjectList projects={[]} isLoading={false} onNewProject={vi.fn()} />,
    );

    expect(
      screen.getByRole("heading", { name: "No projects yet" }),
    ).toBeTruthy();
  });
});
