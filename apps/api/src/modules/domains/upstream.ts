export interface HttpUpstream {
  /** Compose service that answers HTTP for the project. */
  service: "app" | "web";
  port: number;
}

interface UpstreamProject {
  type?: string;
  buildCmd?: string | null;
  port?: number | null;
}

function defaultContainerPort(type: string): number {
  if (type === "PYTHON") return 8000;
  if (type === "PHP") return 80;
  return 3000;
}

/**
 * Where Traefik should send a project's traffic. WordPress and no-build PHP
 * deploy two containers: `app` is PHP-FPM (FastCGI on 9000, which cannot
 * answer HTTP) and `web` is the nginx in front of it on port 80. Every other
 * type runs a single `app` container. This must match the Traefik labels in
 * system/templates/docker-compose/*.yml; upstream.test.ts checks it against
 * them.
 */
export function resolveHttpUpstream(project: UpstreamProject): HttpUpstream {
  const type = project.type?.toUpperCase() ?? "";
  const phpWithoutBuild = type === "PHP" && !project.buildCmd;

  if (type === "WORDPRESS" || phpWithoutBuild) {
    return { service: "web", port: 80 };
  }
  // The static template runs nginx on a fixed port 80, whatever the project's
  // stored port says.
  if (type === "STATIC" || type === "REACT") {
    return { service: "app", port: 80 };
  }
  return { service: "app", port: project.port ?? defaultContainerPort(type) };
}
