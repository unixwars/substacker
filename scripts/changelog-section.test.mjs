import { describe, expect, it } from "vitest";
import { extractSection, normalizeVersion } from "./changelog-section.mjs";

const sample = `# Changelog

Intro text.

## [Unreleased]

### Added

- Something not released.

## [0.2.0] - 2026-12-01

### Fixed

- A fix.

## [0.1.0] - 2026-11-09

### Added

- First thing.
- Second thing.

### Security

- A hardening.

[Unreleased]: https://example.com/compare/v0.2.0...HEAD
[0.2.0]: https://example.com/releases/tag/v0.2.0
[0.1.0]: https://example.com/releases/tag/v0.1.0
`;

describe("normalizeVersion", () => {
  it("accepts a tag or a bare version", () => {
    expect(normalizeVersion("v0.1.0")).toBe("0.1.0");
    expect(normalizeVersion("0.1.0")).toBe("0.1.0");
  });
});

describe("extractSection", () => {
  it("returns the body of the requested version, without its heading or the link references", () => {
    expect(extractSection(sample, "0.1.0")).toBe("### Added\n\n- First thing.\n- Second thing.\n\n### Security\n\n- A hardening.");
  });

  it("stops at the next version heading", () => {
    expect(extractSection(sample, "v0.2.0")).toBe("### Fixed\n\n- A fix.");
  });

  it("does not confuse 0.1.0 with 0.1.01 or 10.1.0", () => {
    expect(extractSection(sample, "0.1")).toBeUndefined();
    expect(extractSection(sample, "10.1.0")).toBeUndefined();
  });

  it("accepts a heading without a date", () => {
    expect(extractSection("## [1.0.0]\n\n- x\n", "1.0.0")).toBe("- x");
  });

  it("returns undefined for a missing version", () => {
    expect(extractSection(sample, "9.9.9")).toBeUndefined();
  });

  it("returns undefined for a section with no content", () => {
    expect(extractSection("## [0.3.0] - 2026-01-01\n\n## [0.2.0] - 2025-01-01\n\n- x\n", "0.3.0")).toBeUndefined();
  });

  it("works with Windows line endings", () => {
    expect(extractSection(sample.replaceAll("\n", "\r\n"), "0.2.0")).toBe("### Fixed\n\n- A fix.");
  });
});
