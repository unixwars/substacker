import { describe, expect, it } from "vitest";
import { checkUrlShape, isBlockedAddress } from "./address.js";

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0", "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "100.127.255.255", "169.254.169.254", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "::ffff:a00:1", "::127.0.0.1",
    "64:ff9b::7f00:1", "2002:7f00:1::1",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"])(
    "allows %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );
  it("blocks a string that is not an address", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});

describe("checkUrlShape", () => {
  const ok = (u: string, opts = {}) => checkUrlShape(new URL(u), opts);
  it("accepts https to a public name or address", () => {
    expect(() => ok("https://cdn.example.test/a.png")).not.toThrow();
    expect(() => ok("https://93.184.216.34/a.png")).not.toThrow();
  });
  it("refuses other schemes and plain http", () => {
    expect(() => ok("ftp://example.test/a")).toThrow(/scheme/);
    expect(() => ok("file:///etc/passwd")).toThrow(/scheme/);
    expect(() => ok("http://example.test/a")).toThrow(/https/);
  });
  it("allows http only when told to", () => {
    expect(() => ok("http://example.test/a", { allowPrivate: true })).not.toThrow();
  });
  it.each([
    "https://127.0.0.1/", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.1/",
    "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://169.254.169.254/latest",
    "https://localhost/", "https://foo.localhost/", "https://localhost./", "https://10.1.2.3/", "https://0/",
  ])("refuses %s", (u) => {
    expect(() => ok(u)).toThrow(/private|loopback|blocked|local/i);
  });
  it("does not refuse private literals when allowPrivate is set", () => {
    expect(() => ok("http://127.0.0.1:8080/", { allowPrivate: true })).not.toThrow();
  });
});
