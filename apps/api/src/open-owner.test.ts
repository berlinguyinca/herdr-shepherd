import { describe, expect, it } from "vitest";
import {
  assertOpenOwnerHost,
  createOpenLimiter,
  isOwnerNetworkAddress,
  isOwnerNetworkHost,
  isProxiedBeyondOwner,
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
  it.each([
    "forwarded",
    "forwarded-for",
    "x-forwarded",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-forwarded-server",
    "x-forwarded-ssl",
    "x-forwarded-scheme",
    "x-forwarded-prefix",
    "x-real-ip",
    "x-client-ip",
    "x-cluster-client-ip",
    "x-original-forwarded-for",
    "via",
    "cf-connecting-ip",
    "cf-ray",
    "cf-ipcountry",
    "true-client-ip",
    "fastly-client-ip",
    "x-azure-clientip",
    "x-azure-ref",
    "x-envoy-external-address",
    "x-envoy-internal",
    "x-appengine-user-ip",
    "tailscale-user-login",
    "tailscale-user-name",
    "tailscale-app-capabilities",
    "x-amzn-trace-id",
    "x-amz-cf-id",
    "X-Client-IP",
  ])("%s marks a proxied request", (name) => {
    expect(isProxiedBeyondOwner(new Headers({ [name]: "127.0.0.1" }))).toBe(true);
  });

  it("lets ordinary browser, app and web-proxy headers through", () => {
    const headers = new Headers({
      host: "127.0.0.1:3100",
      origin: "http://127.0.0.1:5173",
      referer: "http://127.0.0.1:5173/",
      cookie: "session_token=fake",
      authorization: "Bearer fake",
      "content-type": "application/json",
      "content-length": "2",
      accept: "*/*",
      "accept-language": "en",
      "user-agent": "test",
      "sec-fetch-site": "same-origin",
      "sec-ch-ua": "x",
      "sec-websocket-key": "k",
      "x-requested-with": "fetch",
      "x-forwarded-for": "127.0.0.1",
    });
    expect(isProxiedBeyondOwner(headers)).toBe(false);
  });

  it("lets a direct request through", () => {
    expect(isProxiedBeyondOwner(new Headers({ origin: "http://127.0.0.1:5173" }))).toBe(false);
  });

  it.each([
    ["127.0.0.1", false],
    ["100.101.102.103", false],
    ["::1", false],
    ["[::1]:5173", false],
    ["[::1]", false],
    ["127.0.0.1:5173", false],
    ["  127.0.0.1  ", false],
    ["127.0.0.1, 100.101.102.103", false],
    ["fd7a:115c:a1e0::1", false],
    ["[fd7a:115c:a1e0::1]:443", false],
    ["0:0:0:0:0:0:0:1", false],
    ["0000:0000:0000:0000:0000:0000:0000:0001", false],
    ["::ffff:127.0.0.1", false],
    ["::FFFF:127.0.0.1", false],
    ["::ffff:7f00:1", false],
    ["::FFFF:7F00:1", false],
    ["0:0:0:0:0:ffff:7f00:1", false],
    ["[::ffff:127.0.0.1]:5173", false],
    ["::ffff:100.64.0.1", false],
    ["::ffff:6440:1", false],
    ["::ffff:8.8.8.8", true],
    ["::ffff:808:808", true],
    ["::127.0.0.1", true],
    ["::7f00:1", true],
    ["fe80::1%en0", true],
    ["[fe80::1%en0]:5173", true],
    ["::1%lo0", true],
    ["::1:5173", true],
    ["[::1]:99999", true],
    ["[::1]:", true],
    ["[127.0.0.1]", true],
    ["127.0.0.1:99999", true],
    ["127.0.0.1:", true],
    ["127.000.000.001", true],
    ["0127.0.0.1", true],
    ["127.1", true],
    ["2130706433", true],
    ["0x7f.0.0.1", true],
    ["256.0.0.1", true],
    ["203.0.113.9", true],
    ["127.0.0.1, 203.0.113.9", true],
    ["203.0.113.9, 127.0.0.1", true],
    ["127.0.0.1, garbage", true],
    ["127.0.0.1,,127.0.0.1", true],
    ["127.0.0.1,", true],
    ["", true],
    ["   ", true],
    ["unknown", true],
    ["_hidden", true],
    ["localhost", true],
    [`${"127.0.0.1, ".repeat(8)}127.0.0.1`, true],
    [`::${"0".repeat(80)}1`, true],
  ])("x-forwarded-for %j is proxied beyond the owner: %s", (chain, expected) => {
    expect(isProxiedBeyondOwner(new Headers({ "x-forwarded-for": chain }))).toBe(expected);
  });

  it("accepts a chain at the hop limit", () => {
    expect(
      isProxiedBeyondOwner(
        new Headers({ "x-forwarded-for": Array(8).fill("127.0.0.1").join(",") }),
      ),
    ).toBe(false);
  });

  it("accepts the headers the web server sends for a same-machine browser", () => {
    const headers = new Headers({
      host: "127.0.0.1:3100",
      origin: "http://127.0.0.1:5173",
      "x-forwarded-for": "127.0.0.1",
    });
    expect(isProxiedBeyondOwner(headers)).toBe(false);
  });

  it("refuses a chain that carries another forwarding header", () => {
    const headers = new Headers({
      "x-forwarded-for": "127.0.0.1",
      "cf-connecting-ip": "127.0.0.1",
    });
    expect(isProxiedBeyondOwner(headers)).toBe(true);
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
