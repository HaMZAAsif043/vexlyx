import { describe, expect, it } from "vitest";
import { z } from "zod";
import "@/lib/zodConfig";

describe("zodConfig", () => {
  it("turns off Zod's eval-based JIT so a strict CSP is not tripped", () => {
    expect(z.config().jitless).toBe(true);
  });

  it("still validates with the JIT disabled", () => {
    const schema = z.object({ email: z.string().email(), age: z.number().int() });
    expect(schema.safeParse({ email: "ada@example.com", age: 36 }).success).toBe(true);
    expect(schema.safeParse({ email: "nope", age: 1.5 }).success).toBe(false);
  });
});
