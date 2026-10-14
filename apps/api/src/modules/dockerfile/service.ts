import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";
import type { SaveDockerfileInput, DockerfileStatus, DockerfileTemplate } from "./schema.js";
import { getPythonBin } from "../../utils/pythonBin.js";

// ---------------------------------------------------------------------------
// Error definition
// ---------------------------------------------------------------------------

export class DockerfileError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "DockerfileError";
  }
}

// ---------------------------------------------------------------------------
// Locate build_manager.py
// ---------------------------------------------------------------------------

function getBuildManagerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../../../../system/python/build_manager.py"),
    resolve(currentDir, "../../../../system/python/build_manager.py"),
    resolve(process.cwd(), "../../system/python/build_manager.py"),
    resolve(process.cwd(), "system/python/build_manager.py"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0] ?? resolve(process.cwd(), "system/python/build_manager.py");
}

function runPythonCommand<T>(payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const scriptPath = getBuildManagerScriptPath();
    const child = spawn(getPythonBin(), [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const raw = stdout.trim();
      if (!raw) {
        rejectP(
          new DockerfileError(
            `build_manager.py produced no output (stderr: ${stderr.trim()})`,
            "DOCKERFILE_SYSTEM_NO_OUTPUT",
            500,
          ),
        );
        return;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw);
      } catch {
        rejectP(
          new DockerfileError(
            `build_manager.py returned invalid JSON: ${raw}`,
            "DOCKERFILE_SYSTEM_INVALID_JSON",
            500,
          ),
        );
        return;
      }

      if (parsed.error || code !== 0) {
        rejectP(
          new DockerfileError(
            (parsed.error as string) || "System script failed",
            (parsed.code as string) || "DOCKERFILE_SYSTEM_ERROR",
            422,
          ),
        );
        return;
      }

      resolveP(parsed as T);
    });

    child.on("error", (err) => {
      rejectP(
        new DockerfileError(
          `Failed to spawn build_manager.py: ${err.message}`,
          "DOCKERFILE_SYSTEM_SPAWN_ERROR",
          500,
        ),
      );
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Pre-built starter templates for popular stacks (F2.5)
// ---------------------------------------------------------------------------

export const DOCKERFILE_TEMPLATES: DockerfileTemplate[] = [
  {
    id: "node-express",
    name: "Node.js (Multi-stage)",
    category: "JavaScript / TypeScript",
    description: "Production-ready multi-stage Node.js container with security hardening and non-root user.",
    defaultPort: 3000,
    dockerfile: `# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN if [ -f "tsconfig.json" ]; then npm run build --if-present; fi

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nodeuser
COPY --from=builder --chown=nodeuser:nodejs /app ./
USER nodeuser
EXPOSE 3000
CMD ["npm", "start"]
`,
    dockerignore: `node_modules
.git
.gitignore
.env
.env.*
dist
build
.next
npm-debug.log*
`,
  },
  {
    id: "python-fastapi",
    name: "Python (FastAPI / Uvicorn)",
    category: "Python",
    description: "High-performance FastAPI/Flask container with venv, pip caching, and uvicorn server.",
    defaultPort: 8000,
    dockerfile: `# syntax=docker/dockerfile:1
FROM python:3.11-slim AS builder
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \\
    PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends gcc libpq-dev && rm -rf /var/lib/apt/lists/*
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

FROM python:3.11-slim AS runner
WORKDIR /app
ENV PATH="/opt/venv/bin:$PATH" \\
    PORT=8000 \\
    PYTHONUNBUFFERED=1
RUN adduser --disabled-password --gecos "" appuser
COPY --from=builder /opt/venv /opt/venv
COPY . .
USER appuser
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`,
    dockerignore: `__pycache__
*.pyc
*.pyo
*.pyd
.env
.git
.venv
env/
venv/
`,
  },
  {
    id: "go-alpine",
    name: "Go (Alpine Minimal)",
    category: "Go",
    description: "Ultra-compact multi-stage build producing a minimal scratch/alpine binary container.",
    defaultPort: 8080,
    dockerfile: `# syntax=docker/dockerfile:1
FROM golang:1.22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache git ca-certificates
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-w -s" -o /app/server .

FROM alpine:3.19 AS runner
WORKDIR /app
RUN apk --no-cache add ca-certificates tzdata
RUN adduser -D -g '' appuser
COPY --from=builder /app/server /app/server
USER appuser
EXPOSE 8080
ENV PORT=8080
CMD ["/app/server"]
`,
    dockerignore: `.git
.gitignore
.env
*.exe
bin/
`,
  },
  {
    id: "rust-alpine",
    name: "Rust (Slim Binary)",
    category: "Rust",
    description: "Optimized Rust release build with musl toolchain for tiny static container footprint.",
    defaultPort: 8080,
    dockerfile: `# syntax=docker/dockerfile:1
FROM rust:1.78-alpine AS builder
WORKDIR /app
RUN apk add --no-cache musl-dev
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN cargo build --release

FROM alpine:3.19 AS runner
WORKDIR /app
RUN apk --no-cache add ca-certificates
RUN adduser -D -g '' appuser
COPY --from=builder /app/target/release/* /app/server
USER appuser
EXPOSE 8080
ENV PORT=8080
CMD ["/app/server"]
`,
    dockerignore: `target/
.git
.env
`,
  },
  {
    id: "static-nginx",
    name: "Static Website / SPA (Nginx)",
    category: "Static / Frontend",
    description: "Nginx Alpine web server preconfigured for Single Page Applications (React, Vue, Vite, Static HTML).",
    defaultPort: 80,
    dockerfile: `# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS runner
COPY --from=builder /app/dist /usr/share/nginx/html
# Fallback rewrite for SPA routing
RUN printf "server {\\n  listen 80;\\n  location / {\\n    root /usr/share/nginx/html;\\n    index index.html index.htm;\\n    try_files \\$uri \\$uri/ /index.html;\\n  }\\n}\\n" > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,
    dockerignore: `node_modules
.git
dist
build
.env
`,
  },
  {
    id: "bun-http",
    name: "Bun (TypeScript / JavaScript)",
    category: "JavaScript / TypeScript",
    description: "Lightning-fast Bun runtime for modern TypeScript/JavaScript web servers.",
    defaultPort: 3000,
    dockerfile: `# syntax=docker/dockerfile:1
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .

FROM oven/bun:1-alpine AS runner
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production \\
    PORT=3000
EXPOSE 3000
CMD ["bun", "run", "index.ts"]
`,
    dockerignore: `node_modules
.git
.env
`,
  },
  {
    id: "php-nginx",
    name: "PHP 8.3 + Nginx / Composer",
    category: "PHP",
    description: "Modern PHP 8.3 CLI/Web application with Composer and OPcache enabled.",
    defaultPort: 80,
    dockerfile: `# syntax=docker/dockerfile:1
FROM php:8.3-fpm-alpine AS runner
WORKDIR /var/www/html
RUN apk add --no-cache nginx composer
COPY . .
RUN if [ -f "composer.json" ]; then composer install --no-dev --optimize-autoloader; fi
RUN printf "server {\\n  listen 80;\\n  root /var/www/html/public;\\n  index index.php index.html;\\n  location / { try_files \\$uri \\$uri/ /index.php?\\$query_string; }\\n  location ~ \\.php$ { fastcgi_pass 127.0.0.1:9000; fastcgi_param SCRIPT_FILENAME \\$document_root\\$fastcgi_script_name; include fastcgi_params; }\\n}\\n" > /etc/nginx/http.d/default.conf
EXPOSE 80
CMD php-fpm -D && nginx -g "daemon off;"
`,
    dockerignore: `vendor/
.git
.env
`,
  },
];

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

export class DockerfileService {
  constructor(private prisma: PrismaClient) {}

  async getDockerfile(userId: string, projectId: string): Promise<DockerfileStatus> {
    await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    const result = await runPythonCommand<DockerfileStatus>({
      command: "dockerfile-get",
      projectDir,
    });

    return result;
  }

  async saveDockerfile(
    userId: string,
    projectId: string,
    data: SaveDockerfileInput,
  ): Promise<DockerfileStatus> {
    const project = await this.findOwnedProject(userId, projectId);
    const projectDir = resolve(env.PROJECTS_DIR, projectId);

    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    const result = await runPythonCommand<DockerfileStatus>({
      command: "dockerfile-save",
      projectDir,
      dockerfile: data.dockerfile,
      dockerignore: data.dockerignore,
    });

    // Update project type to DOCKER if it was something else and Dockerfile is now saved
    const updates: { type?: "DOCKER"; port?: number } = {};
    if (project.type !== "DOCKER") {
      updates.type = "DOCKER";
    }

    // If syncPort is true or port explicitly supplied, update project port
    if (data.port) {
      updates.port = data.port;
    } else if (data.syncPort && result.exposedPorts && result.exposedPorts.length > 0) {
      updates.port = result.exposedPorts[0];
    }

    if (Object.keys(updates).length > 0) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: updates,
      });
    }

    return result;
  }

  getTemplates(): DockerfileTemplate[] {
    return DOCKERFILE_TEMPLATES;
  }

  private async findOwnedProject(userId: string, projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        userId: true,
        type: true,
        port: true,
        deletedAt: true,
      },
    });

    if (!project || project.deletedAt !== null) {
      throw new DockerfileError("Project not found", "PROJECT_NOT_FOUND", 404);
    }

    if (project.userId !== userId) {
      throw new DockerfileError(
        "You do not have access to this project",
        "FORBIDDEN",
        403,
      );
    }

    return project;
  }
}
