import { describe, expect, it } from "vitest";
import {
  CROCKFORD_ALPHABET,
  generateSupportCode,
  isValidSupportCode,
  normalizeSupportCode,
  SUPPORT_CODE_PATTERN,
} from "../support-code.js";

describe("generateSupportCode", () => {
  it("produces an 8-char code matching the contract pattern", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateSupportCode();
      expect(code).toHaveLength(8);
      expect(code).toMatch(SUPPORT_CODE_PATTERN);
      // Only canonical Crockford symbols (no I/L/O/U, all uppercase).
      for (const ch of code) {
        expect(CROCKFORD_ALPHABET).toContain(ch);
      }
    }
  });

  it("is non-sequential / well-distributed (no constant output)", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) codes.add(generateSupportCode());
    // Collisions across 1000 draws from 32^8 space are astronomically
    // unlikely; require near-total uniqueness.
    expect(codes.size).toBeGreaterThan(995);
  });
});

describe("normalizeSupportCode", () => {
  it("uppercases and strips spaces/dashes", () => {
    expect(normalizeSupportCode("abcd-1234")).toBe("ABCD1234");
    expect(normalizeSupportCode("ab cd 12 34")).toBe("ABCD1234");
    expect(normalizeSupportCode(" AbCd-1234 ")).toBe("ABCD1234");
  });

  it("maps Crockford look-alikes I/L -> 1 and O -> 0", () => {
    expect(normalizeSupportCode("ilo")).toBe("110");
    expect(normalizeSupportCode("IBOD1234")).toBe("1B0D1234");
  });
});

describe("isValidSupportCode", () => {
  it("accepts canonical codes and rejects malformed ones", () => {
    expect(isValidSupportCode("ABCD1234")).toBe(true);
    expect(isValidSupportCode("ABC")).toBe(false); // too short
    expect(isValidSupportCode("ABCD123U")).toBe(false); // U excluded
    expect(isValidSupportCode("abcd1234")).toBe(false); // lowercase not canonical
    expect(isValidSupportCode("ABCD12I4")).toBe(false); // I excluded
  });
});
