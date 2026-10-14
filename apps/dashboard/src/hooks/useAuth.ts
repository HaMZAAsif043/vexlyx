"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { fetchAPI } from "@/lib/api";
import { disconnectSocket, reconnectSocket } from "@/hooks/useSocket";
import type { User } from "@vexlyx/shared";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

export type LoginResult =
  | { status: "done"; user: User }
  | { status: "needs2FA"; challengeToken: string };

export function useAuth() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });

  const fetchUser = useCallback(async () => {
    try {
      const data = await fetchAPI<{ user: User }>("/api/auth/me");
      setState({ user: data.user, isLoading: false, isAuthenticated: true });
    } catch {
      setState({ user: null, isLoading: false, isAuthenticated: false });
    }
  }, []);

  useEffect(() => {
    void fetchUser();
  }, [fetchUser]);

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const data = await fetchAPI<
      { user: User } | { requires2FA: true; challengeToken: string }
    >("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    // fetchAPI only throws on non-2xx; the 202 challenge response resolves
    // here normally, so narrow on the discriminating field.
    if ("requires2FA" in data) {
      return { status: "needs2FA", challengeToken: data.challengeToken };
    }
    // Drop any cached query results from a previous session in this tab —
    // the QueryClient persists across client-side navigation (no hard
    // reload on login/logout), so without this a just-logged-in user could
    // briefly see the previous account's cached data (e.g. its full user
    // list) until each query's staleTime naturally expires.
    queryClient.clear();
    reconnectSocket();
    setState({ user: data.user, isLoading: false, isAuthenticated: true });
    router.push("/dashboard");
    return { status: "done", user: data.user };
  };

  const confirm2FA = async (challengeToken: string, code: string) => {
    const data = await fetchAPI<{ user: User }>("/api/auth/2fa/challenge", {
      method: "POST",
      body: JSON.stringify({ challengeToken, code }),
    });
    queryClient.clear();
    reconnectSocket();
    setState({ user: data.user, isLoading: false, isAuthenticated: true });
    router.push("/dashboard");
    return data.user;
  };

  const register = async (
    name: string,
    email: string,
    password: string,
    confirmPassword: string,
  ) => {
    const data = await fetchAPI<{ user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password, confirmPassword }),
    });
    queryClient.clear();
    reconnectSocket();
    setState({ user: data.user, isLoading: false, isAuthenticated: true });
    router.push("/dashboard");
    return data.user;
  };

  const changePassword = async (
    currentPassword: string,
    newPassword: string,
    confirmNewPassword: string,
  ) => {
    await fetchAPI("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword, confirmNewPassword }),
    });
  };

  const logout = async () => {
    try {
      await fetchAPI("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if the API call fails, clear local state
    }
    queryClient.clear();
    disconnectSocket();
    setState({ user: null, isLoading: false, isAuthenticated: false });
    router.push("/login");
  };

  return {
    ...state,
    login,
    confirm2FA,
    register,
    changePassword,
    logout,
    refetch: fetchUser,
  };
}
