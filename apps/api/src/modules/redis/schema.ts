import { z } from "zod";
import {
  CreateRedisInstanceSchema,
  UpdateRedisInstanceSchema,
  RedisInstanceListQuerySchema,
  type CreateRedisInstanceInput,
  type UpdateRedisInstanceInput,
  type RedisInstanceListQuery,
  type RedisInstanceSummary,
  type RedisInstanceDetail,
  type RedisInstanceStats,
} from "@vexlyx/shared";

export const RedisInstanceIdParamSchema = z.object({
  id: z.string().min(1, "Redis instance ID is required"),
});

export type RedisInstanceIdParam = z.infer<typeof RedisInstanceIdParamSchema>;

export {
  CreateRedisInstanceSchema,
  UpdateRedisInstanceSchema,
  RedisInstanceListQuerySchema,
  type CreateRedisInstanceInput,
  type UpdateRedisInstanceInput,
  type RedisInstanceListQuery,
  type RedisInstanceSummary,
  type RedisInstanceDetail,
  type RedisInstanceStats,
};
