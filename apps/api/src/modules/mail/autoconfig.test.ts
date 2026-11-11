import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
const { settings } = vi.hoisted(() => ({
  settings: { HOSTED_MAIL_HOSTNAME: "mx.provider.test" as string | undefined },
}));
vi.mock("../../config/env.js", () => ({ env: settings }));
import {
  AUTOCONFIG_PATH,
  mailAutoconfigRoutes,
  normalizeMailHostname,
  renderMailAutoconfig,
} from "./autoconfig.js";
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  settings.HOSTED_MAIL_HOSTNAME = "mx.provider.test";
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const findFirst = vi.fn(
    async ({
      where,
    }: {
      where: { hostname: string; status: string; parentId: null };
    }) =>
      where.hostname === "example.test" &&
      where.status === "ACTIVE" &&
      where.parentId === null
        ? { hostname: "example.test" }
        : null,
  );
  const app = Fastify({ trustProxy: true });
  apps.push(app);
  app.decorate("prisma", { domain: { findFirst } } as never);
  await app.register(mailAutoconfigRoutes);
  return { app, findFirst };
}
it("publishes only TLS-enabled IMAP and submission with full-address usernames", async () => {
  const { app, findFirst } = await fixture();
  const response = await app.inject({
    url: AUTOCONFIG_PATH + "?emailaddress=missing%40other.test",
    headers: { host: "EXAMPLE.test:443" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toContain("application/xml");
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.body).toContain('<clientConfig version="1.1">');
  expect(response.body).toContain(
    "<port>993</port>\n      <socketType>SSL</socketType>",
  );
  expect(response.body).toContain(
    "<port>587</port>\n      <socketType>STARTTLS</socketType>",
  );
  expect(
    response.body.match(/<hostname>mx.provider.test<\/hostname>/g),
  ).toHaveLength(2);
  expect(
    response.body.match(/<username>%EMAILADDRESS%<\/username>/g),
  ).toHaveLength(2);
  expect(response.body).not.toMatch(/missing|other.test|<port>465<|<port>25</);
  expect(findFirst).toHaveBeenCalledWith({
    where: { hostname: "example.test", status: "ACTIVE", parentId: null },
    select: { hostname: true },
  });
});
it.each([
  "unknown.test",
  "pending.test",
  "child.example.test",
  "*.example.test",
  "example.test@evil.test",
])("refuses unhosted/invalid host %s", async (host) => {
  const { app } = await fixture();
  expect(
    (await app.inject({ url: AUTOCONFIG_PATH, headers: { host } })).statusCode,
  ).toBe(404);
});
it("does not trust a forwarded host or email query to select a different domain", async () => {
  const { app } = await fixture();
  expect(
    (
      await app.inject({
        url: AUTOCONFIG_PATH + "?emailaddress=alice@example.test",
        headers: { host: "evil.test", "x-forwarded-host": "example.test" },
      })
    ).statusCode,
  ).toBe(404);
});
it.each([
  undefined,
  "mx.provider.test/path",
  "https://mx.provider.test",
  "mx.provider.test\n",
])("refuses missing or unsafe mail-host configuration %j", async (hostname) => {
  settings.HOSTED_MAIL_HOSTNAME = hostname;
  const { app } = await fixture();
  expect(
    (
      await app.inject({
        url: AUTOCONFIG_PATH,
        headers: { host: "example.test" },
      })
    ).statusCode,
  ).toBe(503);
});
it("escapes XML and normalizes valid hostnames", () => {
  expect(renderMailAutoconfig('evil&<>"', "mx&host")).toContain(
    "evil&amp;&lt;&gt;&quot;",
  );
  expect(normalizeMailHostname("MX.Example.test.")).toBe("mx.example.test");
  expect(normalizeMailHostname("-mx.example.test")).toBeNull();
});
