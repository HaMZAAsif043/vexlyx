/** User roles available in the Vexlyx platform */
export type Role = "ADMIN" | "USER" | "RESELLER";

/** Named capabilities (F5.19) grantable on top of a role — additive only. */
export type Permission =
  | "canManageDns"
  | "canManageFirewall"
  | "canManageBackups"
  | "canCreateSubAccounts";

/**
 * Public user object returned by the API.
 * Matches the select shape used in AuthService (id, email, name, role, createdAt).
 * Password is never included.
 */
export type User = {
  id: string;
  email: string;
  name: string;
  role: Role;
  resellerId: string | null;
  maxProjects: number | null;
  maxDomains: number | null;
  maxDatabases: number | null;
  maxMailboxes: number | null;
  maxSubAccounts: number | null;
  permissions: Permission[];
  totpEnabled: boolean;
  createdAt: Date | string;
};

/**
 * Standard API error response shape.
 * Every error returned by the Fastify API must conform to this structure.
 */
export type ApiError = {
  error: string;
  code: string;
  details: Record<string, unknown>;
};

/** Supported project/application types — mirrors the Prisma ProjectType enum */
export type ProjectType =
  | "NODEJS"
  | "NEXTJS"
  | "PYTHON"
  | "REACT"
  | "STATIC"
  | "PHP"
  | "WORDPRESS"
  | "DOCKER";

/** Lifecycle status of a hosted project — mirrors the Prisma ProjectStatus enum */
export type ProjectStatus =
  | "CREATING"
  | "ACTIVE"
  | "STOPPED"
  | "ERROR"
  | "DELETED";

/**
 * Public project object returned by the API.
 * Sensitive internals (deletedAt) are never included in responses.
 */
export type Project = {
  id: string;
  name: string;
  type: ProjectType;
  status: ProjectStatus;
  gitUrl: string | null;
  branch: string;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  port: number | null;
  userId: string;
  /** Short Docker container ID of the running container, or null if not deployed */
  containerId: string | null;
  /** Last known Docker container status (e.g. "running", "exited") */
  containerStatus: string | null;
  /** Host-side port allocated for this container */
  internalPort: number | null;
  /** Traefik-resolved public hostname for this project */
  deployedDomain: string | null;
  /** Timestamp of the most recent successful deployment */
  deployedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** Paginated list response wrapper for projects */
export type PaginatedProjects = {
  projects: Project[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

/**
 * What Nixpacks' plan derives from a project's current source. `null` means the
 * plan proposed nothing, so a blank override stays with Nixpacks' own default.
 */
export type BuildPlan = {
  framework: string;
  detectedType: string | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
};

/** Status of a single deployment attempt — mirrors the Prisma DeploymentStatus enum */
export type DeploymentStatus =
  | "QUEUED"
  | "BUILDING"
  | "DEPLOYING"
  | "RUNNING"
  | "FAILED"
  | "CANCELLED";

/** A single deployment attempt for a project (build + deploy lifecycle) */
export type Deployment = {
  id: string;
  status: DeploymentStatus;
  commitHash: string | null;
  commitMsg: string | null;
  buildLogs: string | null;
  duration: number | null;
  projectId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** Paginated list response wrapper for deployments */
export type PaginatedDeployments = {
  deployments: Deployment[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
};

/**
 * Public environment variable item returned by list endpoint.
 * Values are masked (e.g. ••••••••) for security.
 */
export type EnvVar = {
  id: string;
  key: string;
  maskedValue: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/**
 * Decrypted environment variable item used when specifically revealing a single variable.
 */
export type DecryptedEnvVar = {
  id: string;
  key: string;
  value: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

