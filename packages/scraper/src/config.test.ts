import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const valid = { feedUrl: "https://example.substack.com/feed", feedName: "Example Newsletter" };
const none = () => undefined;

describe("loadConfig", () => {
  it("reads the environment and applies defaults", () => {
    expect(loadConfig({ SUBSTACKER_CONFIG: JSON.stringify(valid) }, none)).toEqual({
      ...valid, actions: [], utmSource: "substacker", hidden: [],
    });
  });
  it("reads the local file", () => {
    const read = (p: string) => (p === "substacker.config.local.json" ? JSON.stringify({ ...valid, hidden: ["x"], actions: ["share"] }) : undefined);
    const c = loadConfig({}, read);
    expect(c.hidden).toEqual(["x"]);
    expect(c.actions).toEqual(["share"]);
  });
  it("lets the environment win over the file", () => {
    const read = () => JSON.stringify({ ...valid, feedName: "From file" });
    expect(loadConfig({ SUBSTACKER_CONFIG: JSON.stringify({ ...valid, feedName: "From env" }) }, read).feedName).toBe("From env");
  });
  it("treats an empty variable as unset", () => {
    expect(loadConfig({ SUBSTACKER_CONFIG: "  " }, () => JSON.stringify(valid)).feedName).toBe("Example Newsletter");
  });
  it("parses the optional relay and subscribe URLs", () => {
    const c = loadConfig({ SUBSTACKER_CONFIG: JSON.stringify({ ...valid, relayUrl: "https://relay.example.workers.dev", subscribeUrl: "https://example.substack.com/subscribe" }) }, none);
    expect(c.relayUrl).toBe("https://relay.example.workers.dev");
    expect(c.subscribeUrl).toBe("https://example.substack.com/subscribe");
  });
  it.each([
    ["a feedUrl that is not http(s)", { feedUrl: "ftp://example.substack.com/feed" }],
    ["a javascript: subscribeUrl", { subscribeUrl: "javascript:alert(1)" }],
    ["a file: feedUrl", { feedUrl: "file:///etc/passwd" }],
    ["a plain http relay", { relayUrl: "http://relay.example.workers.dev" }],
    ["a plain http relay on localhost", { relayUrl: "http://localhost:8787" }],
    ["a non-http relay", { relayUrl: "ftp://relay.example.test" }],
  ])("rejects %s", (_n, extra) => {
    expect(() => loadConfig({ SUBSTACKER_CONFIG: JSON.stringify({ ...valid, ...extra }) }, none)).toThrow(ConfigError);
  });
  it("allows an http relay on localhost only when the test-only option is injected", () => {
    const env = { SUBSTACKER_CONFIG: JSON.stringify({ ...valid, relayUrl: "http://localhost:8787" }) };
    expect(loadConfig(env, none, { allowPrivate: true }).relayUrl).toBe("http://localhost:8787");
    const remote = { SUBSTACKER_CONFIG: JSON.stringify({ ...valid, relayUrl: "http://relay.example.test" }) };
    expect(() => loadConfig(remote, none, { allowPrivate: true })).toThrow(/https/);
  });
  it("bounds maxConcurrentDownloads to 1-8", () => {
    const c = (n: unknown) => loadConfig({ SUBSTACKER_CONFIG: JSON.stringify({ ...valid, maxConcurrentDownloads: n }) }, none);
    expect(c(1).maxConcurrentDownloads).toBe(1);
    expect(c(8).maxConcurrentDownloads).toBe(8);
    for (const bad of [0, 9, 2.5, "4"]) expect(() => c(bad)).toThrow(ConfigError);
  });
  it("fails naming the example file when neither exists", () => {
    expect(() => loadConfig({}, none)).toThrow(/substacker\.config\.example\.json/);
    expect(() => loadConfig({}, none)).toThrow(ConfigError);
  });
  it.each([
    ["not json", "{"],
    ["a missing feedUrl", JSON.stringify({ feedName: "x" })],
    ["a bad URL", JSON.stringify({ ...valid, feedUrl: "nope" })],
    ["a bad action", JSON.stringify({ ...valid, actions: ["like"] })],
    ["an empty name", JSON.stringify({ ...valid, feedName: "" })],
  ])("fails on %s", (_n, text) => {
    expect(() => loadConfig({ SUBSTACKER_CONFIG: text }, none)).toThrow(ConfigError);
  });
});
