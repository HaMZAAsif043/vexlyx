import type { SystemEmailEvent } from "@vexlyx/shared";
import { env } from "../../config/env.js";

export type EmailParams = {
  password_reset: { name: string; resetUrl: string; expiresMinutes: number };
  password_changed: { name: string };
  role_changed: { name: string; newRole: string };
  two_factor_enabled: { name: string };
  two_factor_disabled: { name: string };
  two_factor_reset: { name: string };
  quota_warning: { name: string; resource: string; used: number; limit: number; level: 80 | 100 };
  backup_failed: { error: string; snapshotId: string };
  scheduled_task_failed: { taskName: string; projectName: string; output: string; runId: string };
  test: Record<string, never>;
};

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Public URL of the dashboard, built from trusted config — never from a request's Host header. */
export function panelUrl(path = ""): string {
  const base = env.PANEL_DOMAIN ? `https://${env.PANEL_DOMAIN}` : env.CORS_ORIGIN;
  return `${base.replace(/\/$/, "")}${path}`;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

interface Layout {
  subject: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
}

// Inline styles are deliberate here: email clients strip <style> blocks and
// ignore Tailwind, so inline CSS is the only portable option. The UI-wide
// "no inline styles" rule applies to the dashboard, not to HTML email.
function render({ subject, heading, paragraphs, action }: Layout): RenderedEmail {
  const text = [
    heading,
    "",
    ...paragraphs,
    ...(action ? ["", `${action.label}: ${action.url}`] : []),
    "",
    "— Vexlyx",
  ].join("\n");

  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:480px">',
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(heading)}</h2>`,
    ...paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`),
    action
      ? `<p style="margin:20px 0"><a href="${escapeHtml(action.url)}" style="background:#4f46e5;color:#f8fafc;padding:10px 16px;border-radius:8px;text-decoration:none">${escapeHtml(action.label)}</a></p><p style="margin:0 0 12px;color:#64748b;font-size:12px">${escapeHtml(action.url)}</p>`
      : "",
    '<p style="margin:24px 0 0;color:#64748b;font-size:12px">Sent automatically by your Vexlyx panel. Please do not reply.</p>',
    "</div>",
  ].join("");

  return { subject, text, html };
}

const NOT_YOU = "If this wasn't you, reset your password right away and contact your administrator.";

const RESOURCE_LABELS: Record<string, string> = {
  project: "projects",
  domain: "domains",
  database: "databases",
  mailbox: "mailboxes",
  subAccount: "sub-accounts",
};

const TEMPLATES: { [E in SystemEmailEvent]: (params: EmailParams[E]) => RenderedEmail } = {
  password_reset: ({ name, resetUrl, expiresMinutes }) =>
    render({
      subject: "Reset your Vexlyx password",
      heading: "Reset your password",
      paragraphs: [
        `Hi ${name}, we received a request to reset your password.`,
        `This link works once and expires in ${expiresMinutes} minutes. If you didn't ask for it, you can ignore this email — your password won't change.`,
      ],
      action: { label: "Choose a new password", url: resetUrl },
    }),
  password_changed: ({ name }) =>
    render({
      subject: "Your Vexlyx password was changed",
      heading: "Your password was changed",
      paragraphs: [`Hi ${name}, the password for your account was just changed.`, NOT_YOU],
    }),
  role_changed: ({ name, newRole }) =>
    render({
      subject: "Your Vexlyx role was changed",
      heading: "Your role was changed",
      paragraphs: [`Hi ${name}, an administrator changed your account role to ${newRole}.`],
    }),
  two_factor_enabled: ({ name }) =>
    render({
      subject: "Two-factor authentication enabled",
      heading: "Two-factor authentication is on",
      paragraphs: [`Hi ${name}, two-factor authentication was enabled on your account.`, NOT_YOU],
    }),
  two_factor_disabled: ({ name }) =>
    render({
      subject: "Two-factor authentication disabled",
      heading: "Two-factor authentication is off",
      paragraphs: [`Hi ${name}, two-factor authentication was disabled on your account.`, NOT_YOU],
    }),
  two_factor_reset: ({ name }) =>
    render({
      subject: "Two-factor authentication was reset",
      heading: "Two-factor authentication was reset",
      paragraphs: [
        `Hi ${name}, an administrator reset two-factor authentication on your account. You can set it up again from Settings.`,
      ],
    }),
  quota_warning: ({ name, resource, used, limit, level }) => {
    const label = RESOURCE_LABELS[resource] ?? resource;
    return render({
      subject:
        level === 100
          ? `You've reached your ${label} limit`
          : `You're close to your ${label} limit`,
      heading: level === 100 ? `${label} limit reached` : `${label} limit almost reached`,
      paragraphs: [
        `Hi ${name}, you are using ${used} of ${limit} ${label} on your plan.`,
        level === 100
          ? "You can't create more until you remove some or ask your administrator for a higher limit."
          : "Ask your administrator for a higher limit if you need more room.",
      ],
      action: { label: "Open the panel", url: panelUrl("/dashboard") },
    });
  },
  backup_failed: ({ error, snapshotId }) =>
    render({
      subject: "A Vexlyx backup failed",
      heading: "A backup failed",
      paragraphs: [`Backup ${snapshotId} did not complete.`, `Error: ${error}`],
      action: { label: "View backups", url: panelUrl("/settings") },
    }),
  test: () =>
    render({
      subject: "Vexlyx test email",
      heading: "Email is working",
      paragraphs: [
        "This is a test message from your Vexlyx panel. If you can read it, system email is set up correctly.",
      ],
    }),
  scheduled_task_failed: ({ taskName, projectName, output, runId }) =>
    render({
      subject: `Scheduled task failed: ${taskName}`,
      heading: `Scheduled task "${taskName}" failed`,
      paragraphs: [
        `The scheduled task "${taskName}" for project "${projectName}" has failed 3 times in a row.`,
        `Run ID: ${runId}`,
        `Output: ${output || "(no output)"}`,
        "This task will not trigger failure emails again until it succeeds once.",
      ],
      action: { label: "View task in panel", url: panelUrl("/dashboard") },
    }),
};

export function renderEmail<E extends SystemEmailEvent>(event: E, params: EmailParams[E]): RenderedEmail {
  return TEMPLATES[event](params);
}
