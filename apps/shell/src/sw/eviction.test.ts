import { describe, expect, it } from "vitest";
import { planEviction } from "./eviction.js";

const e = (key: string, bytes: number, lastOpened: number) => ({ key, bytes, lastOpened });

describe("planEviction", () => {
  it("evicts the oldest group first", () => {
    expect(planEviction([e("a", 10, 1), e("a-img", 10, 1), e("b", 10, 2)], 20)).toEqual(["a"]);
  });
  it("never evicts the post opened last, even over the cap", () => {
    expect(planEviction([e("a", 10, 1), e("b", 10, 2), e("b-img", 10, 2)], 1)).toEqual(["a"]);
  });
  it("evicts nothing under the cap or with no entries", () => {
    expect(planEviction([e("a", 10, 1)], 100)).toEqual([]);
    expect(planEviction([], 0)).toEqual([]);
  });
});
