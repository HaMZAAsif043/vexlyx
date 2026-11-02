#!/usr/bin/env node
// One-command local development setup for Vexlyx.
//
//   pnpm bootstrap              core services (Postgres, Redis, Traefik) + DB + seed
//   pnpm bootstrap --full       also build and start mail, DNS, MySQL, webmail, Adminer
//   pnpm bootstrap --check      only verify prerequisites, change nothing
//   pnpm bootstrap --skip-install --no-seed
//
// Cross-platform (Windows, macOS, Linux) and dependency-free on purpose: it runs
// before `pnpm install` has ever happened.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const flags = {
  check: args.has("--check"),
  full: args.has("--full"),
  skipInstall: args.has("--skip-install"),
  noSeed: args.has("--no-seed"),
  help: args.has("--help") || args.has("-h"),
};

const CORE_SERVICES = ["postgres", "redis", "traefik"];
const DEFAULT_POSTGRES_PORT = 5432;
const FALLBACK_POSTGRES_PORT = 5433;
const API_ENV = path.join(ROOT, "apps/api/.env");
const DASHBOARD_ENV = path.join(ROOT, "apps/dashboard/.env.local");
const ROOT_ENV = path.join(ROOT, ".env");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const cyan = paint("36");

let stepNumber = 0;
const step = (title) => console.log(`\n${cyan(`[${++stepNumber}]`)} ${bold(title)}`);
const ok = (message) => console.log(`    ${green("✔")} ${message}`);
const warn = (message) => console.log(`    ${yellow("!")} ${message}`);
const info = (message) => console.log(`    ${dim(message)}`);

class SetupError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function run(command, commandArgs, { capture = false, allowFailure = false, env } = {}) {
  // pnpm is a .cmd shim on Windows, which spawn can only launch through a shell. The
  // arguments are all literals from this file, so joining them into one string is safe.
  const viaShell = process.platform === "win32";
  const spawnOptions = {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, ...env },
  };
  const result = viaShell
    ? spawnSync([command, ...commandArgs].join(" "), { ...spawnOptions, shell: true })
    : spawnSync(command, commandArgs, spawnOptions);
  if (result.error && !allowFailure) {
    throw new SetupError(`Could not run "${command}": ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new SetupError(
      `"${command} ${commandArgs.join(" ")}" failed with exit code ${result.status}.`,
    );
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function probe(command, commandArgs) {
  const result = run(command, commandArgs, { capture: true, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "0.0.0.0");
  });
}

function runningContainers() {
  const output = probe("docker", ["ps", "--format", "{{.Names}}"]);
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function checkPrerequisites() {
  step("Checking prerequisites");

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 22) {
    throw new SetupError(
      `Node.js 22 or newer is required (found ${process.versions.node}).`,
      "Install it from https://nodejs.org or run: nvm install 22",
    );
  }
  ok(`Node.js ${process.versions.node}`);

  const pnpmVersion = probe("pnpm", ["--version"]);
  if (!pnpmVersion) {
    throw new SetupError(
      "pnpm is not installed.",
      "Run: corepack enable   (ships with Node) — or: npm install -g pnpm",
    );
  }
  ok(`pnpm ${pnpmVersion}`);

  if (!probe("git", ["--version"])) {
    throw new SetupError("Git is not installed.", "Install it from https://git-scm.com");
  }
  ok("Git");

  if (!probe("docker", ["--version"])) {
    throw new SetupError(
      "Docker is not installed.",
      "Install Docker Desktop (Windows/macOS) or Docker Engine (Linux): https://docs.docker.com/get-docker/",
    );
  }
  if (!probe("docker", ["info", "--format", "{{.ServerVersion}}"])) {
    throw new SetupError(
      "Docker is installed but the daemon is not running.",
      "Start Docker Desktop (or: sudo systemctl start docker) and re-run.",
    );
  }
  const composeVersion = probe("docker", ["compose", "version", "--short"]);
  if (!composeVersion) {
    throw new SetupError(
      "Docker Compose v2 is missing (the `docker compose` command).",
      "Update Docker Desktop, or install the compose plugin: https://docs.docker.com/compose/install/",
    );
  }
  ok(`Docker running, Compose ${composeVersion}`);

  const python = probe(process.platform === "win32" ? "python" : "python3", ["--version"]);
  if (python) {
    ok(python);
  } else {
    warn("Python 3 not found. Only needed for the system layer and tests/ (Docker deploys, mail, DNS).");
  }
}

function writeSecretsIntoEnv(contents) {
  const withSecret = (text, key) =>
    text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${randomBytes(32).toString("hex")}`);
  return withSecret(withSecret(contents, "SESSION_SECRET"), "ENCRYPTION_KEY");
}

function setEnvValue(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(contents) ? contents.replace(pattern, `${key}=${value}`) : `${contents}\n${key}=${value}\n`;
}

async function resolvePostgresPort() {
  const ownContainerRunning = runningContainers().includes("vexlyx-postgres");
  if (ownContainerRunning) return null;
  if (await isPortFree(DEFAULT_POSTGRES_PORT)) return DEFAULT_POSTGRES_PORT;
  if (await isPortFree(FALLBACK_POSTGRES_PORT)) {
    warn(
      `Port ${DEFAULT_POSTGRES_PORT} is already in use (a local Postgres?) — using ${FALLBACK_POSTGRES_PORT} for Vexlyx instead.`,
    );
    return FALLBACK_POSTGRES_PORT;
  }
  throw new SetupError(
    `Ports ${DEFAULT_POSTGRES_PORT} and ${FALLBACK_POSTGRES_PORT} are both in use.`,
    "Stop the process using one of them, or set POSTGRES_HOST_PORT in a root .env file.",
  );
}

async function prepareFiles() {
  step("Preparing environment files");

  const postgresPort = await resolvePostgresPort();

  if (existsSync(API_ENV)) {
    ok("apps/api/.env already exists — left untouched");
  } else {
    let contents = readFileSync(path.join(ROOT, "apps/api/.env.example"), "utf8");
    contents = writeSecretsIntoEnv(contents);
    if (postgresPort && postgresPort !== DEFAULT_POSTGRES_PORT) {
      contents = contents.replace(/@localhost:5432\//, `@localhost:${postgresPort}/`);
      contents = setEnvValue(contents, "POSTGRES_PORT", String(postgresPort));
    }
    writeFileSync(API_ENV, contents);
    ok("Created apps/api/.env with freshly generated SESSION_SECRET and ENCRYPTION_KEY");
  }

  if (existsSync(DASHBOARD_ENV)) {
    ok("apps/dashboard/.env.local already exists — left untouched");
  } else {
    writeFileSync(DASHBOARD_ENV, readFileSync(path.join(ROOT, "apps/dashboard/.env.example")));
    ok("Created apps/dashboard/.env.local");
  }

  if (postgresPort && postgresPort !== DEFAULT_POSTGRES_PORT && !existsSync(ROOT_ENV)) {
    writeFileSync(ROOT_ENV, `POSTGRES_HOST_PORT=${postgresPort}\n`);
    ok(`Created .env so Docker Compose publishes Postgres on port ${postgresPort}`);
  }

  // Traefik bind-mounts this file. If it is missing, Docker creates a *directory*
  // with that name and Traefik then fails to start.
  const acmeFile = path.join(ROOT, "docker/traefik/acme.json");
  if (!existsSync(acmeFile)) {
    writeFileSync(acmeFile, "{}", { mode: 0o600 });
    ok("Created docker/traefik/acme.json");
  }
  for (const dir of ["docker/mail-data/vhosts", "docker/mail-data/logs"]) {
    mkdirSync(path.join(ROOT, dir), { recursive: true });
  }
}

function ensureTraefikNetwork() {
  step("Docker networks");
  const existing = (probe("docker", ["network", "ls", "--format", "{{.Name}}"]) ?? "").split(/\r?\n/);
  const wanted = [
    ["traefik-net", "panel-internal: Redis, the API, the panel database"],
    ["vexlyx-apps", "shared by Traefik, deployed projects and the database servers"],
  ];
  for (const [name, purpose] of wanted) {
    if (existing.includes(name)) {
      ok(`${name} already exists`);
      continue;
    }
    run("docker", ["network", "create", name], { capture: true });
    ok(`Created ${name} (${purpose})`);
  }
}

function installDependencies() {
  step("Installing dependencies");
  if (flags.skipInstall) {
    info("Skipped (--skip-install)");
    return;
  }
  run("pnpm", ["install"]);
}

function startInfrastructure() {
  step(flags.full ? "Starting the full Docker stack (first build can take a few minutes)" : "Starting Postgres, Redis and Traefik");
  const services = flags.full ? [] : CORE_SERVICES;
  const upArgs = ["compose", "up", "-d", "--wait", ...(flags.full ? ["--build"] : []), ...services];
  const result = run("docker", upArgs, { allowFailure: true });
  if (result.status !== 0) {
    throw new SetupError(
      "Docker services did not become healthy.",
      "Check what is wrong with: docker compose ps  and  docker compose logs <service>\n" +
        "    Ports 80, 443 and 8080 (Traefik) and 6379 (Redis) must be free.",
    );
  }
  ok("Infrastructure is healthy");
}

function prepareDatabase() {
  step("Setting up the database");
  run("pnpm", ["--filter", "@vexlyx/api", "db:generate"]);
  run("pnpm", ["--filter", "@vexlyx/api", "exec", "prisma", "migrate", "deploy"]);
  ok("Migrations applied");
  if (flags.noSeed) {
    info("Seeding skipped (--no-seed)");
    return;
  }
  run("pnpm", ["--filter", "@vexlyx/api", "db:seed"]);
  ok("Development users seeded");
}

function printSummary() {
  const line = dim("─".repeat(58));
  console.log(`\n${line}`);
  console.log(green(bold("  Vexlyx is ready for development.")));
  console.log(line);
  console.log(`
  ${bold("Start the apps")}      pnpm dev

  ${bold("Dashboard")}           http://localhost:3000
  ${bold("API health")}          http://localhost:5000/api/health
  ${bold("Traefik dashboard")}   http://localhost:8080

  ${bold("Dev logins")} ${dim("(password for all: admin123)")}
    admin@vexlyx.local         ${dim("ADMIN")}
    reseller@vexlyx.local      ${dim("RESELLER")}
    sub-account@vexlyx.local   ${dim("USER under the reseller")}

  ${bold("Handy")}
    pnpm infra:down            stop the Docker services
    pnpm db:studio             browse the database
    pnpm bootstrap --check     re-verify prerequisites
`);
}

function printHelp() {
  console.log(`Usage: pnpm bootstrap [options]

  --full           build and start the whole stack (mail, DNS, MySQL, webmail, Adminer)
  --check          only verify prerequisites, change nothing
  --skip-install   skip \`pnpm install\`
  --no-seed        skip seeding the development users
  -h, --help       show this help
`);
}

async function main() {
  if (flags.help) return printHelp();

  console.log(bold("\nVexlyx — local development setup"));
  checkPrerequisites();
  if (flags.check) {
    console.log(`\n${green("All prerequisites look good.")}`);
    return;
  }

  await prepareFiles();
  ensureTraefikNetwork();
  installDependencies();
  startInfrastructure();
  prepareDatabase();
  printSummary();
}

main().catch((error) => {
  console.error(`\n${red("✖")} ${bold(error.message)}`);
  if (error instanceof SetupError && error.hint) console.error(`  ${error.hint}`);
  else if (!(error instanceof SetupError)) console.error(error);
  console.error(dim("\nThe script is safe to re-run; completed steps are skipped.\n"));
  process.exit(1);
});
