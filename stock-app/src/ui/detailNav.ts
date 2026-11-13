// 從個股頁裡再打開另一檔（例如主動式 ETF 的買賣成份股）：疊在上面，按返回回到原本那檔（11/13 使用者）
import type { Scored } from "../engine/score";
let push: ((s: Scored, list?: Scored[]) => void) | undefined;
export const setPushDetail = (f: typeof push) => { push = f; };
export const pushDetail = (s: Scored, list?: Scored[]) => push?.(s, list);
