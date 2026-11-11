import type {
  QueueListResponse,
  QueueActionResult,
  DeliveryLogResponse,
  DeliveryLogFilterInput,
} from "@vexlyx/shared";

import { runPostfixManager } from "./manager.js";

export class MailQueueService {
  /**
   * Lists all messages currently in the Postfix mail queue (F4.8). Server-wide
   * across all tenants — gated at the route level to ADMIN only.
   */
  async listQueue(): Promise<QueueListResponse> {
    return runPostfixManager<QueueListResponse>("queue_list");
  }
  async deleteQueueMessage(queueId: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_delete", { queueId });
  }
  async flushQueue(queueId?: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_flush", { queueId });
  }
  async holdQueueMessage(queueId: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_hold", { queueId });
  }
  async releaseQueueMessage(queueId: string): Promise<QueueActionResult> {
    return runPostfixManager<QueueActionResult>("queue_release", { queueId });
  }
  /**
   * Tails and filters Postfix's delivery/bounce log (F4.8). Server-wide
   * across all tenants — gated at the route level to ADMIN only, so no
   * per-user domain/mailbox ownership check is applied here.
   */
  async getDeliveryLog(
    filter: DeliveryLogFilterInput,
  ): Promise<DeliveryLogResponse> {
    return runPostfixManager<DeliveryLogResponse>("delivery_log", filter);
  }
}
