// Re-export shared schemas for API layer
import { z } from "zod";
import {
  CreateScheduledTaskSchema,
  UpdateScheduledTaskSchema,
  ScheduledTaskRunStatusSchema,
  ScheduledTaskRunTriggerSchema,
  ScheduledTaskIdParamSchema,
  ScheduledTaskProjectParamSchema,
  RunNowBodySchema,
  ScheduledTaskResponseSchema,
  ScheduledTaskRunResponseSchema,
  ScheduledTaskListQuerySchema,
} from "@vexlyx/shared/schemas/scheduledTasks";

export {
  ScheduledTaskRunStatusSchema,
  ScheduledTaskRunTriggerSchema,
  CreateScheduledTaskSchema,
  UpdateScheduledTaskSchema,
  ScheduledTaskIdParamSchema,
  ScheduledTaskProjectParamSchema,
  RunNowBodySchema,
  ScheduledTaskResponseSchema,
  ScheduledTaskRunResponseSchema,
  ScheduledTaskListQuerySchema,
};

export type CreateScheduledTaskInput = z.infer<typeof CreateScheduledTaskSchema>;
export type UpdateScheduledTaskInput = z.infer<typeof UpdateScheduledTaskSchema>;