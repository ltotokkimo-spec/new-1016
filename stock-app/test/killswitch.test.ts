import { describe, expect, it } from "vitest";
import { isBlocked } from "../src/lib/update";

describe("遠端停用（minVersionCode）", () => {
  it("版本號低於門檻才停用；門檻 0 或讀不到版本號都不停用", () => {
    expect(isBlocked(338, 340)).toBe(true);
    expect(isBlocked(340, 340)).toBe(false);
    expect(isBlocked(345, 340)).toBe(false);
    expect(isBlocked(338, 0)).toBe(false);
    expect(isBlocked(undefined, 340)).toBe(false);
  });
});
