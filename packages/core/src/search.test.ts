import { describe, expect, it } from "vitest";
import { createSearcher, evictionOrder } from "./search.js";

const docs = [
  { slug: "garden", title: "Notes from the garden", text: "Tomatoes and basil grow well in summer." },
  { slug: "tomato", title: "Tomato season", text: "A long post about soup." },
  { slug: "cities", title: "Cities", text: "The tomato appears once, near the end." },
  { slug: "cafe", title: "Café culture", text: "Espresso in the morning." },
];

describe("createSearcher", () => {
  const s = createSearcher(docs);
  it("returns nothing for an empty or blank query", () => {
    expect(s.query("")).toEqual([]);
    expect(s.query("   ")).toEqual([]);
  });
  it("returns nothing when nothing matches", () => {
    expect(s.query("zzzzqqq")).toEqual([]);
  });
  it("ranks a title match above a body match", () => {
    const hits = s.query("tomato");
    expect(hits[0]).toBe("tomato");
    expect(hits).toContain("cities");
    expect(hits.indexOf("tomato")).toBeLessThan(hits.indexOf("cities"));
  });
  it("matches a prefix", () => {
    expect(s.query("espre")).toEqual(["cafe"]);
  });
  it("tolerates a typo", () => {
    expect(s.query("gardan")).toContain("garden");
  });
  it("matches accented text without the accent", () => {
    expect(s.query("cafe")).toContain("cafe");
  });
  it("works with no documents", () => {
    expect(createSearcher([]).query("anything")).toEqual([]);
  });
});

describe("evictionOrder", () => {
  const entries = [
    { key: "new", bytes: 40, lastOpened: 300 },
    { key: "old", bytes: 40, lastOpened: 100 },
    { key: "mid", bytes: 40, lastOpened: 200 },
  ];
  it("evicts nothing under the cap", () => {
    expect(evictionOrder(entries, 200)).toEqual([]);
  });
  it("evicts nothing at the cap", () => {
    expect(evictionOrder(entries, 120)).toEqual([]);
  });
  it("evicts the least recently opened first, only as many as needed", () => {
    expect(evictionOrder(entries, 119)).toEqual(["old"]);
    expect(evictionOrder(entries, 79)).toEqual(["old", "mid"]);
  });
  it("evicts everything when even one entry is over the cap", () => {
    expect(evictionOrder(entries, 10)).toEqual(["old", "mid", "new"]);
  });
  it("breaks ties by key so the order is deterministic", () => {
    const tied = [
      { key: "b", bytes: 10, lastOpened: 1 },
      { key: "a", bytes: 10, lastOpened: 1 },
    ];
    expect(evictionOrder(tied, 10)).toEqual(["a"]);
  });
  it("does not modify its input", () => {
    const copy = JSON.stringify(entries);
    evictionOrder(entries, 10);
    expect(JSON.stringify(entries)).toBe(copy);
  });
  it("handles no entries", () => {
    expect(evictionOrder([], 0)).toEqual([]);
  });
});
