import type { Redis } from "ioredis";

const DELIVERY_TTL_SECONDS = 86_400;

type DeliveryStore = Pick<Redis, "set" | "del">;

function deliveryKey(deliveryId: string): string {
  return `github:webhook-delivery:${deliveryId}`;
}

export function readDeliveryId(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value ? value : undefined;
}

/** Returns false when this delivery ID was already claimed within the last 24 hours. */
export async function claimDelivery(redis: DeliveryStore, deliveryId: string): Promise<boolean> {
  const claimed = await redis.set(deliveryKey(deliveryId), "processing", "EX", DELIVERY_TTL_SECONDS, "NX");
  return claimed !== null;
}

/** Frees a claim so GitHub's retry of a failed delivery is processed instead of ignored. */
export async function releaseDelivery(redis: DeliveryStore, deliveryId: string): Promise<void> {
  await redis.del(deliveryKey(deliveryId));
}
