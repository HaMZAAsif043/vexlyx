import type { PrismaClient } from "@prisma/client";
import type { FastifyBaseLogger } from "fastify";
import { MailAuthService } from "./auth-service.js";
import { MailDiagnosticsService } from "./diagnostics-service.js";
import { MailQueueService } from "./queue-service.js";
import { MailDomainService } from "./domains-service.js";
export { MailError } from "./errors.js";
export { runPostfixManager, runDovecotManager } from "./manager.js";
export { synchronizeMailState } from "./synchronize.js";

/** Stable API facade; implementation is grouped by mail operation. */
export class MailService {
  private readonly auth: MailAuthService;
  private readonly diagnostics: MailDiagnosticsService;
  private readonly queue = new MailQueueService();
  private readonly domains: MailDomainService;
  constructor(
    prisma: PrismaClient,
    logger?: Pick<FastifyBaseLogger, "error" | "warn">,
  ) {
    this.auth = new MailAuthService(prisma, logger);
    this.diagnostics = new MailDiagnosticsService(prisma);
    this.domains = new MailDomainService(prisma, this.auth);
  }
  getStatus(...args: Parameters<MailDiagnosticsService["getStatus"]>) {
    return this.diagnostics.getStatus(...args);
  }
  sendTestEmail(...args: Parameters<MailDiagnosticsService["sendTestEmail"]>) {
    return this.diagnostics.sendTestEmail(...args);
  }
  testOpenRelay(...args: Parameters<MailDiagnosticsService["testOpenRelay"]>) {
    return this.diagnostics.testOpenRelay(...args);
  }
  getWebmailStatus(
    ...args: Parameters<MailDiagnosticsService["getWebmailStatus"]>
  ) {
    return this.diagnostics.getWebmailStatus(...args);
  }
  getWebmailActivity(
    ...args: Parameters<MailDiagnosticsService["getWebmailActivity"]>
  ) {
    return this.diagnostics.getWebmailActivity(...args);
  }
  listQueue(...args: Parameters<MailQueueService["listQueue"]>) {
    return this.queue.listQueue(...args);
  }
  deleteQueueMessage(
    ...args: Parameters<MailQueueService["deleteQueueMessage"]>
  ) {
    return this.queue.deleteQueueMessage(...args);
  }
  flushQueue(...args: Parameters<MailQueueService["flushQueue"]>) {
    return this.queue.flushQueue(...args);
  }
  holdQueueMessage(...args: Parameters<MailQueueService["holdQueueMessage"]>) {
    return this.queue.holdQueueMessage(...args);
  }
  releaseQueueMessage(
    ...args: Parameters<MailQueueService["releaseQueueMessage"]>
  ) {
    return this.queue.releaseQueueMessage(...args);
  }
  getDeliveryLog(...args: Parameters<MailQueueService["getDeliveryLog"]>) {
    return this.queue.getDeliveryLog(...args);
  }
  listVirtualDomains(
    ...args: Parameters<MailDomainService["listVirtualDomains"]>
  ) {
    return this.domains.listVirtualDomains(...args);
  }
  syncVirtualDomains(
    ...args: Parameters<MailDomainService["syncVirtualDomains"]>
  ) {
    return this.domains.syncVirtualDomains(...args);
  }
  syncVirtualAliases(
    ...args: Parameters<MailDomainService["syncVirtualAliases"]>
  ) {
    return this.domains.syncVirtualAliases(...args);
  }
  getMailAuthStatus(...args: Parameters<MailAuthService["getMailAuthStatus"]>) {
    return this.auth.getMailAuthStatus(...args);
  }
  ensureEmailAuthRecords(
    ...args: Parameters<MailAuthService["ensureEmailAuthRecords"]>
  ) {
    return this.auth.ensureEmailAuthRecords(...args);
  }
  getOrGenerateDkim(...args: Parameters<MailAuthService["getOrGenerateDkim"]>) {
    return this.auth.getOrGenerateDkim(...args);
  }
  rotateDkim(...args: Parameters<MailAuthService["rotateDkim"]>) {
    return this.auth.rotateDkim(...args);
  }
}

export { senderBelongsToDomains } from "./sender-policy.js";
