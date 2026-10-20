import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ScheduledTaskRunStatusSchema = z.enum([
  "RUNNING",
  "SUCCESS",
  "FAILED",
  "TIMEOUT",
  "SKIPPED",
]);

export const ScheduledTaskRunTriggerSchema = z.enum(["SCHEDULED", "MANUAL"]);

// ---------------------------------------------------------------------------
// Input Schemas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Cron validation — 5 fields (no seconds), every field range-checked with the
// same rules BullMQ (cron-parser) uses to arm a repeatable job. The previous
// regex only checked the character class: it rejected valid `*/5` steps and
// accepted out-of-range junk like `99 99 99 99 99`, which BullMQ then refused
// at arm time — after the row had already been saved.
// ---------------------------------------------------------------------------

/** [min, max] per field: minute, hour, day-of-month, month, day-of-week. */
const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // 0 and 7 are both Sunday
];

const NUMERIC = /^[0-9]+$/;
const STEP = /^[1-9][0-9]*$/;

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field.length === 0) return false;

  for (const term of field.split(",")) {
    const segments = term.split("/");
    const range = segments[0] ?? "";
    const step = segments[1];
    if (segments.length > 2) return false; // only one "/step" per term
    if (step !== undefined && !STEP.test(step)) return false; // "*\/0" and "*\/01" are invalid

    if (range === "*") continue;
    if (range.length === 0) return false;

    const bounds = range.split("-");
    const from = bounds[0] ?? "";
    const to = bounds[1];
    if (bounds.length > 2) return false; // only one "-" range per term
    if (!NUMERIC.test(from)) return false;
    const fromN = Number(from);
    if (fromN < min || fromN > max) return false;

    if (to !== undefined) {
      if (!NUMERIC.test(to)) return false;
      const toN = Number(to);
      if (toN < min || toN > max || toN < fromN) return false;
    }
  }

  return true;
}

/** True when `expression` is a cron string BullMQ can arm (5 fields, in range). */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== CRON_FIELD_RANGES.length) return false;
  return fields.every((field, index) => {
    const [min, max] = CRON_FIELD_RANGES[index]!;
    return isValidCronField(field, min, max);
  });
}

// Field shapes without defaults. The create schema layers create-time
// defaults on top; the update schema must stay default-free (see below).
const scheduledTaskFields = {
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(2000),
  schedule: z
    .string()
    .max(100)
    .refine(isValidCronExpression, {
      message: "Invalid cron expression (5 fields: minute hour day month weekday, no seconds)",
    }),
  timeoutSeconds: z.number().int().min(1).max(3600),
  enabled: z.boolean(),
  notifyOnFailure: z.boolean(),
};

export const CreateScheduledTaskSchema = z.object({
  ...scheduledTaskFields,
  timeoutSeconds: scheduledTaskFields.timeoutSeconds.default(300),
  enabled: scheduledTaskFields.enabled.default(true),
  notifyOnFailure: scheduledTaskFields.notifyOnFailure.default(true),
});

// In Zod 4, `.partial()` keeps the wrapped defaults, so a partial of the
// create schema would still inject `timeoutSeconds: 300`, `enabled: true` and
// `notifyOnFailure: true` for omitted keys — a pause request would reset the
// timeout/notify settings, and an update that omits `enabled` would resume a
// paused task. Build the update shape from the default-free fields instead.
export const UpdateScheduledTaskSchema = z.object(scheduledTaskFields).partial();

export const ScheduledTaskProjectParamSchema = z.object({
  id: z.string().cuid(),
});

export const ScheduledTaskIdParamSchema = z.object({
  id: z.string().cuid(),
  taskId: z.string().cuid(),
});

export const RunNowBodySchema = z.object({});

// ---------------------------------------------------------------------------
// Response Schemas
// ---------------------------------------------------------------------------

export const ScheduledTaskResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  userId: z.string(),
  name: z.string(),
  command: z.string(),
  schedule: z.string(),
  timeoutSeconds: z.number(),
  enabled: z.boolean(),
  notifyOnFailure: z.boolean(),
  consecutiveFailures: z.number(),
  lastRunAt: z.date().nullable(),
  nextRunAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const ScheduledTaskRunResponseSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  trigger: ScheduledTaskRunTriggerSchema,
  status: ScheduledTaskRunStatusSchema,
  exitCode: z.number().nullable(),
  output: z.string().nullable(),
  startedAt: z.date(),
  finishedAt: z.date().nullable(),
});

export const ScheduledTaskListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50).optional(),
  cursor: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateScheduledTaskInput = z.infer<typeof CreateScheduledTaskSchema>;
export type UpdateScheduledTaskInput = z.infer<typeof UpdateScheduledTaskSchema>;
export type ScheduledTaskResponse = z.infer<typeof ScheduledTaskResponseSchema>;
export type ScheduledTaskRunResponse = z.infer<typeof ScheduledTaskRunResponseSchema>;
export type ScheduledTaskRunStatus = z.infer<typeof ScheduledTaskRunStatusSchema>;
export type ScheduledTaskRunTrigger = z.infer<typeof ScheduledTaskRunTriggerSchema>;
export type ScheduledTaskListQuery = z.infer<typeof ScheduledTaskListQuerySchema>;