"use client";

import { useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { useAuth } from "@/hooks/useAuth";
import { useAuthConfig } from "@/hooks/useAuthConfig";
import { ApiRequestError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { toast } from "sonner";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

const codeSchema = z.object({
  code: z
    .string()
    .regex(/^[0-9a-zA-Z-]{6,12}$/, "Enter the 6-digit code or a recovery code"),
});

type FieldErrors = Partial<Record<"email" | "password" | "code" | "root", string>>;

export function LoginForm() {
  const { login, confirm2FA } = useAuth();
  const { allowRegistration } = useAuthConfig();
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [challengeToken, setChallengeToken] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrors({});

    const formData = new FormData(e.currentTarget);
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;

    const result = loginSchema.safeParse({ email, password });

    if (!result.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of result.error.issues) {
        const field = issue.path[0] as keyof FieldErrors;
        fieldErrors[field] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setIsLoading(true);

    try {
      const result = await login(email, password);
      if (result.status === "needs2FA") {
        setChallengeToken(result.challengeToken);
        return;
      }
      toast.success("Welcome back!");
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrors({ root: err.message });
        toast.error(err.message);
      } else {
        setErrors({ root: "An unexpected error occurred" });
        toast.error("An unexpected error occurred");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!challengeToken) return;
    setErrors({});

    const formData = new FormData(e.currentTarget);
    const code = ((formData.get("code") as string) ?? "").trim();

    const result = codeSchema.safeParse({ code });
    if (!result.success) {
      setErrors({ code: result.error.issues[0]?.message ?? "Invalid code" });
      return;
    }

    setIsLoading(true);

    try {
      await confirm2FA(challengeToken, code);
      toast.success("Welcome back!");
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setErrors({ root: err.message });
        toast.error(err.message);
      } else {
        setErrors({ root: "An unexpected error occurred" });
        toast.error("An unexpected error occurred");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackToPassword = () => {
    setChallengeToken(null);
    setErrors({});
  };

  return (
    <Card className="border-border">
      <CardHeader className={cn("space-y-1 text-center")}>
        <h1 className="text-xl font-semibold tracking-tight">
          {challengeToken ? "Two-factor verification" : "Sign in to Vexlyx"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {challengeToken
            ? "Enter the code from your authenticator app"
            : "Enter your credentials to access the panel"}
        </p>
      </CardHeader>
      <CardContent>
        {challengeToken ? (
          <form key="two-factor" onSubmit={handleCodeSubmit} className="space-y-4">
            {errors.root && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {errors.root}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="2fa-code">Authenticator code</Label>
              <Input
                id="2fa-code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={12}
                autoFocus
                disabled={isLoading}
                aria-invalid={!!errors.code}
              />
              {errors.code && (
                <p className="text-xs text-destructive">{errors.code}</p>
              )}
              <p className="text-xs text-muted-foreground">
                6-digit code from your authenticator app, or a recovery code.
              </p>
            </div>

            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? "Verifying…" : "Verify"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={isLoading}
              onClick={handleBackToPassword}
            >
              Back to sign in
            </Button>
          </form>
        ) : (
          <>
            <form key="password" onSubmit={handleSubmit} className="space-y-4">
              {errors.root && (
                <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {errors.root}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="login-email">Email</Label>
                <Input
                  id="login-email"
                  name="email"
                  type="email"
                  placeholder="admin@example.com"
                  autoComplete="email"
                  autoFocus
                  disabled={isLoading}
                  aria-invalid={!!errors.email}
                />
                {errors.email && (
                  <p className="text-xs text-destructive">{errors.email}</p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="login-password">Password</Label>
                  <Link
                    href="/forgot-password"
                    className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="login-password"
                  name="password"
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  disabled={isLoading}
                  aria-invalid={!!errors.password}
                />
                {errors.password && (
                  <p className="text-xs text-destructive">{errors.password}</p>
                )}
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={isLoading}
              >
                {isLoading ? "Signing in…" : "Sign in"}
              </Button>
            </form>

            {allowRegistration && (
              <div className="mt-4 text-center text-sm text-muted-foreground">
                Don&apos;t have an account?{" "}
                <Link
                  href="/register"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  Create one
                </Link>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
