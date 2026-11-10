import { describe, expect, it } from "vitest";
import { createActorLimiter } from "./actor-limiter.js";

describe("createActorLimiter", () => {
  it("allows the limit per key, then refuses until the window passes", () => {
    let clock = 1_000;
    const allow = createActorLimiter(2, 60_000, () => clock);
    expect([allow("a"), allow("a"), allow("a")]).toEqual([true, true, false]);
    expect(allow("b")).toBe(true);
    clock += 60_001;
    expect(allow("a")).toBe(true);
  });
});
