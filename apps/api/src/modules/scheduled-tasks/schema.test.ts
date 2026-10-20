import { describe, expect, it } from "vitest";
import {
  CreateScheduledTaskSchema,
  UpdateScheduledTaskSchema,
} from "@vexlyx/shared/schemas/scheduledTasks";

// In Zod 4, `.partial()` keeps the wrapped defaults. Building the update
// schema from `CreateScheduledTaskSchema.partial()` therefore injected
// `timeoutSeconds: 300`, `enabled: true` and `notifyOnFailure: true` into
// every partial update: a pause request reset the timeout/notification
// settings, and an update that omitted `enabled` resumed a paused task.
describe("UpdateScheduledTaskSchema", () => {
  it("leaves omitted fields untouched instead of applying create-time defaults", () => {
    expect(UpdateScheduledTaskSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(UpdateScheduledTaskSchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
    expect(UpdateScheduledTaskSchema.parse({ timeoutSeconds: 60 })).toEqual({ timeoutSeconds: 60 });
  });

  it("still applies create-time defaults on create", () => {
    const parsed = CreateScheduledTaskSchema.parse({
      name: "nightly",
      command: "echo hi",
      schedule: "0 0 * * *",
    });
    expect(parsed).toMatchObject({ timeoutSeconds: 300, enabled: true, notifyOnFailure: true });
  });

  it("validates fields that are provided", () => {
    expect(() => UpdateScheduledTaskSchema.parse({ schedule: "99 99 99 99 99" })).toThrow();
    expect(() => UpdateScheduledTaskSchema.parse({ timeoutSeconds: 0 })).toThrow();
    expect(() => UpdateScheduledTaskSchema.parse({ name: "" })).toThrow();
    expect(() => UpdateScheduledTaskSchema.parse({ enabled: "yes" })).toThrow();
  });
});
