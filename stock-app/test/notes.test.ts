import { describe, expect, it } from "vitest";
import { latestNotes } from "../src/lib/notes";

describe("更新說明只顯示最新的", () => {
  const txt = ["・a", "・b", "・c", "・d", "・e", "・f", "・g", ""].join("\n");
  it("新的排最前面，只取 5 項，其餘收起來", () => {
    const r = latestNotes(txt);
    expect(r.shown).toEqual(["・g", "・f", "・e", "・d", "・c"]);
    expect(r.hidden).toEqual(["・b", "・a"]);
  });
  it("不足 5 項就全部顯示，空行不算", () => {
    expect(latestNotes("・a\n\n・b\n")).toEqual({ shown: ["・b", "・a"], hidden: [] });
    expect(latestNotes("")).toEqual({ shown: [], hidden: [] });
  });
});
