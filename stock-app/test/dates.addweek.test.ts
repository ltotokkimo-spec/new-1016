import { describe, expect, it } from "vitest";
import { addWeekdays } from "../src/lib/dates";

describe("addWeekdays", () => {
  it("只算平日：週四 +1 = 週五，週五 +1 = 下週一，10/27 +5 = 11/3", () => {
    expect(addWeekdays("20261029", 1)).toBe("20261030");
    expect(addWeekdays("20261030", 1)).toBe("20261102");
    expect(addWeekdays("20261027", 5)).toBe("20261103");
    expect(addWeekdays("20261027", 0)).toBe("20261027");
  });
});
