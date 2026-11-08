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
