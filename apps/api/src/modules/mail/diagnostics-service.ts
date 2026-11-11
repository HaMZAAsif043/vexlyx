import { MailError } from "./errors.js";
import { senderBelongsToDomains } from "./sender-policy.js";
import type { PrismaClient } from "@prisma/client";
import type {
  SmtpStatusResponse,
  ImapStatusResponse,
  WebmailStatusResponse,
  SendTestEmailInput,
  TestEmailResultResponse,
  WebmailActivityResponse,
} from "@vexlyx/shared";
import { env } from "../../config/env.js";

import {
  runPostfixManager,
  runDovecotManager,
  runWebmailManager,
} from "./manager.js";

export class MailDiagnosticsService {
  constructor(private readonly prisma: PrismaClient) {}
  /**
   * Probes and returns Postfix SMTP + OpenDKIM and Dovecot IMAP service health.
   */
  async getStatus(): Promise<SmtpStatusResponse> {
    const smtpHost = process.env.SMTP_HOST || "127.0.0.1";
    const imapHost = process.env.IMAP_HOST || "127.0.0.1";

    const [smtpResult, imapResult] = await Promise.all([
      runPostfixManager<SmtpStatusResponse>("status", { host: smtpHost }),
      runDovecotManager<ImapStatusResponse>("status", { host: imapHost }).catch(
        () => undefined,
      ),
    ]);

    return { ...smtpResult, imap: imapResult };
  }
  /**
   * Sends a test email via Postfix SMTP, returning the full SMTP handshake transcript.
   */
  async sendTestEmail(
    userId: string,
    input: SendTestEmailInput,
  ): Promise<TestEmailResultResponse> {
    const senderDomain = input.from.split("@").pop()!.toLowerCase();
    const ownedDomains = await this.prisma.domain.findMany({
      where: { userId, status: "ACTIVE", parentId: null },
      select: { hostname: true },
    });

    if (
      !senderBelongsToDomains(
        senderDomain,
        ownedDomains.map((d) => d.hostname),
      )
    ) {
      throw new MailError(
        `Sender ${input.from} is not on a domain you own. Use an address on one of your mail domains.`,
        "SENDER_NOT_OWNED",
        403,
      );
    }

    const host = process.env.SMTP_HOST || "127.0.0.1";
    const payload = {
      ...input,
      host,
    };

    const result = await runPostfixManager<TestEmailResultResponse>(
      "send_test_email",
      payload,
    );
    return result;
  }
  /**
   * Verifies open relay protection by simulating an unauthorized external-to-external delivery.
   */
  async testOpenRelay(): Promise<{
    safe: boolean;
    relayDenied: boolean;
    rcptResponse: string;
    transcript: string[];
  }> {
    const host = process.env.SMTP_HOST || "127.0.0.1";
    const port = Number(process.env.SMTP_PORT || 25);
    const result = await runPostfixManager<{
      safe: boolean;
      relayDenied: boolean;
      rcptResponse: string;
      transcript: string[];
    }>("test_relay", { host, port });
    return result;
  }
  /**
   * Probes the Roundcube webmail container's reachability and running state.
   */
  async getWebmailStatus(): Promise<WebmailStatusResponse> {
    const host = process.env.WEBMAIL_HOST || "127.0.0.1";
    const result = await runWebmailManager<WebmailStatusResponse>("status", {
      host,
      port: env.WEBMAIL_PORT,
      url: env.WEBMAIL_URL,
    });
    return result;
  }
  /**
   * Queries Roundcube's own SQLite database for each of the user's mailboxes'
   * most recent login (F4.8).
   */
  async getWebmailActivity(userId: string): Promise<WebmailActivityResponse> {
    const mailboxes = await this.prisma.mailbox.findMany({
      where: { userId },
      select: { address: true },
    });

    return runWebmailManager<WebmailActivityResponse>("recent_logins", {
      addresses: mailboxes.map((m) => m.address),
    });
  }
}
