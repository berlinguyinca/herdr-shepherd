import { describe, expect, it } from "vitest";
import { agentIdFromRoute, agentRouteId } from "./agent-route";

const ids = [
  "herdr:mac.lan:default:wD%3ApF",
  "herdr:mac.lan:default:wD:pF",
  "a b",
  "ünï–日本",
  "x$y~z/w",
  "100%",
  "a1",
];

describe("agent route id", () => {
  it.each(ids)("round-trips %s", (id) => {
    expect(agentIdFromRoute(agentRouteId(id))).toBe(id);
  });
  it.each(ids)("is invariant under extra decodes: %s", (id) => {
    const r = agentRouteId(id);
    expect(decodeURIComponent(r)).toBe(r);
    expect(decodeURIComponent(decodeURIComponent(r))).toBe(r);
    expect(agentIdFromRoute(decodeURIComponent(r))).toBe(id);
  });
  it("matches the live example", () => {
    expect(agentRouteId("herdr:mac.lan:default:wD%3ApF")).toBe(
      "herdr$3Amac.lan$3Adefault$3AwD$253ApF",
    );
  });
  it("handles arrays, undefined, empty and malformed", () => {
    expect(agentIdFromRoute(["a$3Ab", "x"])).toBe("a:b");
    expect(agentIdFromRoute(undefined)).toBeNull();
    expect(agentIdFromRoute([])).toBeNull();
    expect(agentIdFromRoute("")).toBeNull();
    expect(agentIdFromRoute("$zz")).toBeNull();
  });
});
