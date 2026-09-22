import assert from "node:assert/strict";
import test from "node:test";
import { loadCalendar, addWorkingHours } from "../src/calendar.js";
import calendarRef from "../reference/workday-calendar-2026.json" with { type: "json" };

const calendar = loadCalendar(calendarRef);
const at = (iso) => new Date(iso);

test("工作小时在工作日 09:00–18:00 内流动", () => {
  // 周一 09:00 + 24 工作小时 = 周三 15:00（每天 9 小时）
  assert.equal(addWorkingHours(calendar, at("2026-06-08T09:00:00+08:00"), 24).toISOString(), new Date("2026-06-10T15:00:00+08:00").toISOString());
  // 周五 09:00 + 9 小时 = 周五 18:00
  assert.equal(addWorkingHours(calendar, at("2026-06-12T09:00:00+08:00"), 9).toISOString(), new Date("2026-06-12T18:00:00+08:00").toISOString());
  // 周五 09:00 + 10 小时，跨过周末 = 周一 10:00
  assert.equal(addWorkingHours(calendar, at("2026-06-12T09:00:00+08:00"), 10).toISOString(), new Date("2026-06-15T10:00:00+08:00").toISOString());
});

test("非工作时间启动的计时从下一个工作时刻起算", () => {
  // 周一 20:00 + 1 小时 = 周二 10:00
  assert.equal(addWorkingHours(calendar, at("2026-06-08T20:00:00+08:00"), 1).toISOString(), new Date("2026-06-09T10:00:00+08:00").toISOString());
  // 周一 08:00 + 1 小时 = 周一 10:00
  assert.equal(addWorkingHours(calendar, at("2026-06-08T08:00:00+08:00"), 1).toISOString(), new Date("2026-06-08T10:00:00+08:00").toISOString());
});

test("端午假期（周五）阻断计时，假期后继续", () => {
  // 周四 09:00 + 24h：周四耗 9h，周五端午放假，周末休息，周一耗 9h，余 6h → 周二 15:00
  assert.equal(addWorkingHours(calendar, at("2026-06-18T09:00:00+08:00"), 24).toISOString(), new Date("2026-06-23T15:00:00+08:00").toISOString());
});

test("调休上班的周末按工作日处理", () => {
  // 2026-05-09 周六为劳动节调休上班日：周五 09:00 + 16h → 周五 9h + 周六 7h = 周六 16:00
  assert.equal(addWorkingHours(calendar, at("2026-05-08T09:00:00+08:00"), 16).toISOString(), new Date("2026-05-09T16:00:00+08:00").toISOString());
});

test("国庆黄金周后恢复计时", () => {
  // 9/30 周三 09:00 + 10h：当日 9h，10/1–10/7 放假 → 10/8 周四 10:00
  assert.equal(addWorkingHours(calendar, at("2026-09-30T09:00:00+08:00"), 10).toISOString(), new Date("2026-10-08T10:00:00+08:00").toISOString());
});
