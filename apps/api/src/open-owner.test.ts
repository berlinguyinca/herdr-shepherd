import { describe, expect, it } from "vitest";
import {
  assertOpenOwnerHost,
  createOpenLimiter,
  hasForwardingHeaders,
  isOwnerNetworkAddress,
  isOwnerNetworkHost,
  openOwnerOriginAllowed,
  resolveAccessMode,
} from "./open-owner.js";

describe("peer address classifier", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.255.255.254", true],
    ["::1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["100.64.0.0", true],
    ["100.100.100.100", true],
    ["100.127.255.255", true],
    ["::ffff:100.64.0.1", true],
    ["fd7a:115c:a1e0::1", true],
    ["fd7a:115c:a1e0:ab12::5", true],
    ["100.63.255.255", false],
    ["100.128.0.0", false],
    ["10.0.0.1", false],
    ["192.168.1.10", false],
    ["172.16.0.1", false],
    ["8.8.8.8", false],
    ["0.0.0.0", false],
    ["::", false],
    ["::ffff:8.8.8.8", false],
    ["::ffff:10.0.0.1", false],
    ["fd7a:115c:a1e1::1", false],
    ["fe80::1", false],
    ["2001:db8::1", false],
    ["127.0.0.1%en0", false],
    ["localhost", false],
    ["", false],
    ["not an address", false],
    [undefined, false],
  ])("%s -> %s", (address, expected) => {
    expect(isOwnerNetworkAddress(address)).toBe(expected);
  });
});

describe("bind host classifier", () => {
  it.each([
    ["127.0.0.1", true],
    ["localhost", true],
    ["::1", true],
    ["[::1]", true],
    ["100.101.102.103", true],
    ["fd7a:115c:a1e0::1234", true],
    ["0.0.0.0", false],
    ["::", false],
    ["[::]", false],
    ["192.168.1.2", false],
    ["example.com", false],
    ["", false],
  ])("%s -> %s", (host, expected) => {
    expect(isOwnerNetworkHost(host)).toBe(expected);
  });

  it("refuses to start open-owner mode on a wildcard or public bind address", () => {
    expect(() => assertOpenOwnerHost("0.0.0.0")).toThrow(/API_HOST/);
    expect(() => assertOpenOwnerHost("203.0.113.7")).toThrow(/open-owner/);
    expect(() => assertOpenOwnerHost("127.0.0.1")).not.toThrow();
    expect(() => assertOpenOwnerHost("100.64.1.2")).not.toThrow();
  });
});

describe("access mode", () => {
  it("is accounts unless open-owner is spelled out", () => {
    expect(resolveAccessMode(undefined)).toBe("accounts");
    expect(resolveAccessMode("")).toBe("accounts");
    expect(resolveAccessMode("accounts")).toBe("accounts");
    expect(resolveAccessMode("open-owner")).toBe("open-owner");
  });

  it("rejects anything else rather than guessing", () => {
    expect(() => resolveAccessMode("open")).toThrow(/RAKAZO_ACCESS_MODE/);
    expect(() => resolveAccessMode("true")).toThrow(/RAKAZO_ACCESS_MODE/);
  });
});

describe("request origin", () => {
  const allowed = ["http://100.64.0.9:5173", "https://box.tail1234.ts.net"];
  it.each([
    ["http://100.64.0.9:5173", true],
    ["https://box.tail1234.ts.net", true],
    ["rakazo://", true],
    ["http://evil.example", false],
    ["http://100.64.0.9:5174", false],
    ["http://100.64.0.9:5173.evil.example", false],
    ["null", false],
    ["", false],
    [undefined, false],
  ])("%s -> %s", (origin, expected) => {
    expect(openOwnerOriginAllowed(origin, allowed)).toBe(expected);
  });
});

describe("forwarding headers", () => {
  it.each(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip"])(
    "%s marks a proxied request",
    (name) => {
      expect(hasForwardingHeaders(new Headers({ [name]: "203.0.113.9" }))).toBe(true);
    },
  );

  it("lets a direct request through", () => {
    expect(hasForwardingHeaders(new Headers({ origin: "http://127.0.0.1:5173" }))).toBe(false);
  });
});

describe("open limiter", () => {
  it("refuses past the limit and recovers after the window", () => {
    let time = 0;
    const allow = createOpenLimiter(2, 1000, () => time);
    expect([allow(), allow(), allow()]).toEqual([true, true, false]);
    time = 1001;
    expect(allow()).toBe(true);
  });
});
