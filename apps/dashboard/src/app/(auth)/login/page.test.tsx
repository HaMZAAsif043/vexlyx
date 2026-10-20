import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiRequestError } from "@/lib/api";
import LoginPage from "./page";

const { login, confirm2FA } = vi.hoisted(() => ({
  login: vi.fn(),
  confirm2FA: vi.fn(),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ login, confirm2FA }),
}));

vi.mock("@/hooks/useAuthConfig", () => ({
  useAuthConfig: () => ({ allowRegistration: false }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.resetAllMocks();
  login.mockResolvedValue({ status: "done" });
});

async function submitCredentials() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "admin@example.com");
  await user.type(screen.getByLabelText("Password"), "test-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("LoginPage", () => {
  it("renders the sign-in form and submits credentials", async () => {
    render(<LoginPage />);

    expect(
      screen.getByRole("heading", { name: "Sign in to Vexlyx" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Forgot password?" })
        .getAttribute("href"),
    ).toBe("/forgot-password");
    expect(screen.queryByRole("link", { name: "Create one" })).toBeNull();

    await submitCredentials();

    expect(login).toHaveBeenCalledExactlyOnceWith(
      "admin@example.com",
      "test-password",
    );
    await waitFor(() => {
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Sign in" })
          .disabled,
      ).toBe(false);
    });
  });

  it("shows validation errors without attempting to sign in", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(screen.getByText("Invalid email address")).toBeTruthy();
    expect(screen.getByText("Password is required")).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
  });

  it("shows rejected credentials and lets the user retry", async () => {
    login.mockRejectedValueOnce(
      new ApiRequestError("Invalid credentials", "UNAUTHORIZED", 401),
    );
    render(<LoginPage />);

    const user = await submitCredentials();

    expect(await screen.findByText("Invalid credentials")).toBeTruthy();
    expect(confirm2FA).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.queryByText("Invalid credentials")).toBeNull(),
    );
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("requests a second factor before completing a challenged login", async () => {
    login.mockResolvedValueOnce({
      status: "needs2FA",
      challengeToken: "test-challenge",
    });
    render(<LoginPage />);

    const user = await submitCredentials();

    expect(
      await screen.findByRole("heading", { name: "Two-factor verification" }),
    ).toBeTruthy();
    expect(confirm2FA).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText<HTMLInputElement>("Authenticator code").value,
    ).toBe("");
    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    expect(
      screen.getByLabelText<HTMLInputElement>("Authenticator code").value,
    ).toBe("123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(confirm2FA).toHaveBeenCalledExactlyOnceWith(
      "test-challenge",
      "123456",
    );
  });
});
