import { describe, expect, it } from "vitest";
import { nameGrade } from "../src/adapters/verification.js";

describe("nameGrade", () => {
  it("matches the same words in any order and case", () => {
    expect(nameGrade("Dattu Ajay Babu", "AJAY BABU DATTU")).toBe("DIRECT_MATCH");
    expect(nameGrade("erra  andrews", "ERRA ANDREWS")).toBe("DIRECT_MATCH");
  });
  it("rejects different, missing or extra words and missing names", () => {
    expect(nameGrade("Dattu Ajay Babu", "AJAY DATTU")).toBeNull();
    expect(nameGrade("Dattu Ajay", "AJAY BABU DATTU")).toBeNull();
    expect(nameGrade("D Ajay Babu", "AJAY BABU DATTU")).toBeNull();
    expect(nameGrade("Dattu Ajay Babu", null)).toBeNull();
    expect(nameGrade("", "")).toBeNull();
  });
});
