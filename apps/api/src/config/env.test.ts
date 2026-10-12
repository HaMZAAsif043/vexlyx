import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined>) {
  const nextEnv: NodeJS.ProcessEnv = {
    ...originalEnv,
    DATABASE_URL: "postgresql://vexlyx:test@localhost:5432/vexlyx_test",
    SESSION_SECRET: "test-session-secret-that-is-at-least-32-characters",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete nextEnv[key];
    else nextEnv[key] = value;
  }
  process.env = nextEnv;
  vi.resetModules();
  return (await import("./env.js")).env;
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe("Hosted mail DNS environment configuration", () => {
  it("preserves the installer-configured mail hostname and domain", async () => {
    const env = await loadEnv({
      HOSTED_MAIL_HOSTNAME: "mx1.mailhost.net",
      HOSTED_MAIL_DOMAIN: "example.org",
    });

    expect(env.HOSTED_MAIL_HOSTNAME).toBe("mx1.mailhost.net");
    expect(env.HOSTED_MAIL_DOMAIN).toBe("example.org");
  });
});

describe("Adminer environment configuration", () => {
  it("keeps the localhost default in development", async () => {
    const env = await loadEnv({
      NODE_ENV: "development",
      ADMINER_URL: undefined,
    });

    expect(env.ADMINER_URL).toBe("http://localhost:8088");
  });

  it("disables Adminer by default in production", async () => {
    const env = await loadEnv({
      NODE_ENV: "production",
      ADMINER_URL: undefined,
    });

    expect(env.ADMINER_URL).toBeUndefined();
  });

  it("treats an empty ADMINER_URL as unset (compose passes it through blank)", async () => {
    const env = await loadEnv({ NODE_ENV: "production", ADMINER_URL: "" });

    expect(env.ADMINER_URL).toBeUndefined();
  });

  it("rejects an insecure production URL", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", ADMINER_URL: "http://db.example.com" }),
    ).rejects.toThrow("ADMINER_URL must use HTTPS in production");
  });

  it("rejects a production localhost URL even over HTTPS", async () => {
    await expect(
      loadEnv({
        NODE_ENV: "production",
        ADMINER_URL: "https://localhost:8088",
      }),
    ).rejects.toThrow("ADMINER_URL must not point to localhost in production");
  });

  it("accepts an explicit HTTPS production URL", async () => {
    const env = await loadEnv({
      NODE_ENV: "production",
      ADMINER_URL: "https://db-admin.example.com",
    });

    expect(env.ADMINER_URL).toBe("https://db-admin.example.com");
  });
});

describe("System email environment configuration (F5.23)", () => {
  it("prints mail to the log outside production and uses SMTP in production", async () => {
    const dev = await loadEnv({
      NODE_ENV: "development",
      EMAIL_TRANSPORT: undefined,
    });
    expect(dev.EMAIL_TRANSPORT).toBe("log");

    const prod = await loadEnv({
      NODE_ENV: "production",
      EMAIL_TRANSPORT: undefined,
    });
    expect(prod.EMAIL_TRANSPORT).toBe("smtp");
  });

  it("refuses the log transport in production, where it would print reset links", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", EMAIL_TRANSPORT: "log" }),
    ).rejects.toThrow(/EMAIL_TRANSPORT/);
  });

  it("derives the sender from the panel domain with no configuration", async () => {
    const env = await loadEnv({
      PANEL_DOMAIN: "panel.example.com",
      MAIL_DOMAIN: undefined,
      MAIL_FROM: undefined,
    });
    expect(env.MAIL_DOMAIN).toBe("panel.example.com");
    expect(env.MAIL_FROM).toBe("notifications@panel.example.com");
  });

  it("requires SMTP username and password together", async () => {
    await expect(
      loadEnv({ EMAIL_SMTP_USER: "resend", EMAIL_SMTP_PASS: undefined }),
    ).rejects.toThrow(/EMAIL_SMTP_USER/);
  });

  it("keeps admin email reset off unless explicitly enabled", async () => {
    expect(
      (await loadEnv({ ALLOW_ADMIN_EMAIL_RESET: undefined }))
        .ALLOW_ADMIN_EMAIL_RESET,
    ).toBe(false);
    expect(
      (await loadEnv({ ALLOW_ADMIN_EMAIL_RESET: "true" }))
        .ALLOW_ADMIN_EMAIL_RESET,
    ).toBe(true);
  });
});
