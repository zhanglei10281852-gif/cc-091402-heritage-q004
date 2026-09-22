import assert from "node:assert/strict";
import test from "node:test";
import { WorkCalendar } from "../src/calendar.js";
import { loadReference } from "../src/config.js";

const calendar = new WorkCalendar(loadReference().calendar);

function cst(value) {
  return new Date(value);
}

test("截止时间只在工作日 09:00-17:00 内流逝", () => {
  // 周二 10:00 + 24 工作小时：周二剩 7h、周三 8h、周四 8h（共 23h），
  // 9/25 放假跳过，调休上班的 9/26（周六）09:00 起再 1h => 10:00
  const deadline = calendar.addWorkingHours(cst("2026-09-22T10:00:00+08:00"), 24);
  assert.equal(deadline.toISOString(), new Date("2026-09-26T10:00:00+08:00").toISOString());
});

test("非工作时刻开始时，截止时间从下一个工作时段 09:00 起算", () => {
  // 周二早 07:00 + 1 工作小时 => 周二 10:00
  const deadline = calendar.addWorkingHours(cst("2026-09-22T07:00:00+08:00"), 1);
  assert.equal(deadline.toISOString(), new Date("2026-09-22T10:00:00+08:00").toISOString());
});

test("周末自然跳过", () => {
  // 周五 16:00 + 2 工作小时：周五剩 1h，周一 09:00 再补 1h
  const deadline = calendar.addWorkingHours(cst("2026-09-18T16:00:00+08:00"), 2);
  assert.equal(deadline.toISOString(), new Date("2026-09-21T10:00:00+08:00").toISOString());
});

test("法定假日跳过，但调休上班的周末计入", () => {
  // 9/25（周五，中秋假期）放假，9/26（周六）调休上班
  // 周四 9/24 16:00 + 9 工作小时：当天剩 1h，跳过 9/25，9/26 09:00 起再 8h => 9/26 17:00
  const deadline = calendar.addWorkingHours(cst("2026-09-24T16:00:00+08:00"), 9);
  assert.equal(deadline.toISOString(), new Date("2026-09-26T17:00:00+08:00").toISOString());
});

test("国庆整周假期跳到下一周", () => {
  // 10/1-10/7 放假，10/8 周四上班
  const deadline = calendar.addWorkingHours(cst("2026-09-30T16:00:00+08:00"), 2);
  assert.equal(deadline.toISOString(), new Date("2026-10-08T10:00:00+08:00").toISOString());
});

test("工作时段判定", () => {
  assert.equal(calendar.isWithinWorkingHours(cst("2026-09-22T09:00:00+08:00")), true);
  assert.equal(calendar.isWithinWorkingHours(cst("2026-09-22T17:00:00+08:00")), false);
  assert.equal(calendar.isWithinWorkingHours(cst("2026-09-22T12:00:00+08:00")), true);
  assert.equal(calendar.isWithinWorkingHours(cst("2026-09-19T12:00:00+08:00")), false); // 周六
  assert.equal(calendar.isWithinWorkingHours(cst("2026-09-26T10:00:00+08:00")), true); // 调休周六
  assert.equal(calendar.isWithinWorkingHours(cst("2026-09-25T10:00:00+08:00")), false); // 假日
});
