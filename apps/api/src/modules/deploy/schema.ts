import { z } from "zod";
import { HostnameSchema } from "@vexlyx/shared";

export const DeployBodySchema = z.object({
  // Goes verbatim into a Traefik `Host(...)` rule; an unvalidated value can
  // close the matcher and append rules that match other tenants' hosts.
  domain: HostnameSchema.optional(),
});

export type DeployBody = z.infer<typeof DeployBodySchema>;

export const ContainerActionBodySchema = z.object({
  action: z.enum(["start", "stop", "restart", "remove"]),
});

export type ContainerActionBody = z.infer<typeof ContainerActionBodySchema>;

export const LogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(5000).default(100),
});

export type LogsQuery = z.infer<typeof LogsQuerySchema>;
