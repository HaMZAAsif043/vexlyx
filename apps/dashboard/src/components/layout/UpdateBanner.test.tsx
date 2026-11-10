import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SystemUpdateInfo } from "@vexlyx/shared/schemas/systemUpdate";

const hookState = vi.hoisted(() => ({
  isAdmin: true,
  update: undefined as SystemUpdateInfo | undefined,
}));

vi.mock("@/hooks/useSystemUpdate", () => ({
  useSystemUpdate: () => hookState,
}));

const { UpdateBanner } = await import("./UpdateBanner");

const updateInfo: SystemUpdateInfo = {
  currentVersion: "0.4.3",
  latestVersion: "0.4.4",
  updateAvailable: true,
  releaseUrl: "https://github.com/atlantiqshq/vexlyx/releases/tag/v0.4.4",
  publishedAt: "2026-11-02T10:00:00Z",
  checkedAt: "2026-11-02T12:00:00Z",
  checkEnabled: true,
  checkFailed: false,
};

describe("UpdateBanner", () => {
  beforeEach(() => {
    hookState.isAdmin = true;
    hookState.update = updateInfo;
    window.localStorage.clear();
  });

  it("announces a newer release with release notes and upgrade links", () => {
    render(<UpdateBanner />);

    expect(screen.getByText(/0\.4\.4/)).toBeTruthy();
    expect(screen.getByText(/0\.4\.3/)).toBeTruthy();

    const release = screen.getByRole("link", { name: /Release notes/i });
    expect(release.getAttribute("href")).toBe(updateInfo.releaseUrl);

    const upgrade = screen.getByRole("link", { name: /How to upgrade/i });
    expect(upgrade.getAttribute("href")).toContain("operations#upgrading");
  });

  it("stays hidden for non-admins", () => {
    hookState.isAdmin = false;

    render(<UpdateBanner />);

    expect(screen.queryByText(/0\.4\.4/)).toBeNull();
  });

  it("stays hidden when no update is available or the check failed", () => {
    hookState.update = {
      ...updateInfo,
      latestVersion: null,
      updateAvailable: false,
      checkFailed: true,
    };

    render(<UpdateBanner />);

    expect(screen.queryByRole("link", { name: /Release notes/i })).toBeNull();
  });

  it("remembers dismissal for that version", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<UpdateBanner />);

    await user.click(screen.getByRole("button", { name: /Dismiss update notice/i }));
    expect(screen.queryByText(/0\.4\.4/)).toBeNull();
    expect(window.localStorage.getItem("vexlyx.update.dismissed")).toBe("0.4.4");

    unmount();
    render(<UpdateBanner />);
    await waitFor(() => {
      expect(screen.queryByText(/0\.4\.4/)).toBeNull();
    });
  });
});
