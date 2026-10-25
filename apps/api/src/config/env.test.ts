import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

async function loadEnv(overrides: Record<string, string | undefined>) {
  const nextEnv: NodeJS.ProcessEnv = {
    ...originalEnv,
    DATABASE_URL: "postgresql://vexlyx:test@localhost:5432/vexlyx_test",
    SESSION_SECRET: "test-session-secret-that-is-at-least-32-characters",
    ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-characters",
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

describe("ENCRYPTION_KEY requirements (#69)", () => {
  const strongKey = "dedicated-encryption-key-at-least-32-characters-long";
  const base = { NODE_ENV: "production", EMAIL_TRANSPORT: "smtp" };

  it("refuses to boot in production without ENCRYPTION_KEY", async () => {
    await expect(loadEnv({ ...base, ENCRYPTION_KEY: undefined })).rejects.toThrow(/ENCRYPTION_KEY is required/);
  });

  it("allows a missing key in production only with the legacy fallback flag", async () => {
    const env = await loadEnv({
      ...base,
      ENCRYPTION_KEY: undefined,
      ENCRYPTION_KEY_LEGACY_FALLBACK: "true",
    });

    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect(env.ENCRYPTION_KEY_LEGACY_FALLBACK).toBe(true);
  });

  it("rejects the .env.example placeholder in production", async () => {
    await expect(
      loadEnv({
        ...base,
        ENCRYPTION_KEY: "change-me-to-a-random-32-char-string-in-production",
      }),
    ).rejects.toThrow(/placeholder/);
  });

  it("rejects an ENCRYPTION_KEY equal to SESSION_SECRET in production", async () => {
    await expect(
      loadEnv({
        ...base,
        SESSION_SECRET: strongKey,
        ENCRYPTION_KEY: strongKey,
      }),
    ).rejects.toThrow(/must differ from SESSION_SECRET/);
  });

  it("accepts a dedicated key in production", async () => {
    const env = await loadEnv({ ...base, ENCRYPTION_KEY: strongKey });

    expect(env.ENCRYPTION_KEY).toBe(strongKey);
  });

  it("keeps the zero-config fallback outside production", async () => {
    const env = await loadEnv({ NODE_ENV: "development", ENCRYPTION_KEY: undefined });

    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });
});

describe("Deployed project memory limit", () => {
  it("defaults to 512m so a WordPress or PHP site is not starved", async () => {
    const env = await loadEnv({ DEPLOY_MEMORY_LIMIT: undefined });

    expect(env.DEPLOY_MEMORY_LIMIT).toBe("512m");
  });

  it("honors an operator override", async () => {
    const env = await loadEnv({ DEPLOY_MEMORY_LIMIT: "1g" });

    expect(env.DEPLOY_MEMORY_LIMIT).toBe("1g");
  });
});
