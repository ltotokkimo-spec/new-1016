import { describe, expect, it } from "vitest";
import { navFit } from "../src/ui/common";

describe("個股頁標題：名稱太長時箭頭與字級自動縮小", () => {
  it("短名稱用最大的 60 箭頭，越長越小", () => {
    expect(navFit("長榮航")).toEqual({ arrow: 60, font: 17 });
    expect(navFit("主動中信台灣收益").arrow).toBe(60);
    expect(navFit("富邦台灣中小A級動能50").arrow).toBe(50);
    expect(navFit("Applied Optoelectronics").arrow).toBe(42);
    expect(navFit("Taiwan Semiconductor Manufacturing")).toEqual({ arrow: 36, font: 14 });
  });
});
