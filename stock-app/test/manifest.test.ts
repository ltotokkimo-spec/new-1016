import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Android 設定", () => {
  it("不允許自動備份：API 金鑰與持股存在 App 資料裡，不能被備份到 Google 雲端", () => {
    const xml = readFileSync(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
    expect(xml).toMatch(/android:allowBackup="false"/);
  });
});
