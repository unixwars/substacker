import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION, ContractError, parseDocs, parseIndex, parsePost } from "./contract.js";

const entry = { slug: "hello", title: "Hello", date: "2026-01-02T03:04:05.000Z", excerpt: "Hi", cover: null };
const index = { version: CONTRACT_VERSION, title: "Example Newsletter", posts: [entry] };
const post = {
  version: CONTRACT_VERSION,
  ...entry,
  cover: "images/abc.jpg",
  html: "<p>Hi</p>",
  sourceUrl: "https://example.substack.com/p/hello",
  contentHash: "deadbeef",
  unlocalized: 0,
};

function catchError(fn: () => unknown): ContractError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ContractError);
    return e as ContractError;
  }
  throw new Error("expected a ContractError");
}

describe("parseIndex", () => {
  it("accepts a good payload", () => {
    expect(parseIndex(index)).toEqual(index);
  });
  it("accepts an empty index", () => {
    expect(parseIndex({ ...index, posts: [] }).posts).toEqual([]);
  });
  it("accepts an older version", () => {
    expect(parseIndex({ ...index, version: 0 }).version).toBe(0);
  });
  it.each(["version", "title", "posts"])("rejects a missing %s", (key) => {
    const bad: Record<string, unknown> = { ...index };
    delete bad[key];
    expect(catchError(() => parseIndex(bad)).reason).toBe("malformed");
  });
  it.each(["slug", "title", "date", "excerpt"])("rejects an entry missing %s", (key) => {
    const bad: Record<string, unknown> = { ...entry };
    delete bad[key];
    expect(catchError(() => parseIndex({ ...index, posts: [bad] })).reason).toBe("malformed");
  });
  it("rejects a non-object", () => {
    expect(catchError(() => parseIndex("nope")).reason).toBe("malformed");
    expect(catchError(() => parseIndex(null)).reason).toBe("malformed");
  });
  it("reports a newer version as newer, even if the rest does not match", () => {
    const err = catchError(() => parseIndex({ version: CONTRACT_VERSION + 1, shape: "unknown" }));
    expect(err.reason).toBe("newer");
    expect(err.name).toBe("ContractError");
  });
});

describe("parsePost", () => {
  it("accepts a good payload", () => {
    expect(parsePost(post)).toEqual(post);
  });
  it.each(["version", "slug", "title", "date", "excerpt", "cover", "html", "sourceUrl", "contentHash", "unlocalized"])(
    "rejects a missing %s",
    (key) => {
      const bad: Record<string, unknown> = { ...post };
      delete bad[key];
      expect(catchError(() => parsePost(bad)).reason).toBe("malformed");
    },
  );
  it("rejects a negative unlocalized count", () => {
    expect(catchError(() => parsePost({ ...post, unlocalized: -1 })).reason).toBe("malformed");
  });
  it("reports a newer version", () => {
    expect(catchError(() => parsePost({ ...post, version: CONTRACT_VERSION + 1 })).reason).toBe("newer");
  });
});

describe("parseDocs", () => {
  const docs = [{ slug: "hello", title: "Hello", text: "Hi there" }];
  it("accepts a good payload", () => {
    expect(parseDocs(docs)).toEqual(docs);
    expect(parseDocs([])).toEqual([]);
  });
  it.each(["slug", "title", "text"])("rejects a doc missing %s", (key) => {
    const bad: Record<string, unknown> = { ...docs[0] };
    delete bad[key];
    expect(catchError(() => parseDocs([bad])).reason).toBe("malformed");
  });
  it("rejects a non-array", () => {
    expect(catchError(() => parseDocs({})).reason).toBe("malformed");
  });
});
