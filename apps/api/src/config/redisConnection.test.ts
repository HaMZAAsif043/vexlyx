import { describe, expect, it } from "vitest";
import { parseRedisUrl, redisUrlHasPassword } from "./redisConnection.js";

describe("parseRedisUrl", () => {
  it("carries the password so BullMQ can authenticate", () => {
    expect(parseRedisUrl("redis://:s3cret@redis:6379")).toEqual({
      host: "redis",
      port: 6379,
      password: "s3cret",
    });
  });

  it("decodes percent-encoded credentials and reads user, port and database", () => {
    expect(parseRedisUrl("redis://panel:p%40ss@cache.internal:6380/2")).toEqual({
      host: "cache.internal",
      port: 6380,
      username: "panel",
      password: "p@ss",
      db: 2,
    });
  });

  it("enables TLS for rediss://", () => {
    expect(parseRedisUrl("rediss://:s3cret@redis:6379").tls).toEqual({});
  });

  it("omits credentials when the URL has none", () => {
    expect(parseRedisUrl("redis://localhost")).toEqual({ host: "localhost", port: 6379 });
  });

  it("rejects other schemes", () => {
    expect(() => parseRedisUrl("http://redis:6379")).toThrow(/redis:\/\//);
  });
});

describe("redisUrlHasPassword", () => {
  it("is true only for a non-empty password", () => {
    expect(redisUrlHasPassword("redis://:s3cret@redis:6379")).toBe(true);
    expect(redisUrlHasPassword("redis://redis:6379")).toBe(false);
    expect(redisUrlHasPassword("redis://:@redis:6379")).toBe(false);
    expect(redisUrlHasPassword("not a url")).toBe(false);
  });
});
