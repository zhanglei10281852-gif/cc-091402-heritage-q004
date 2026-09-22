/**
 * 工作日/工作时间计算。中国自 1991 年起无夏令时，Asia/Shanghai 固定为 UTC+8，
 * 因此直接使用固定偏移即可，无需引入时区库。
 * 截止时间一律计算为绝对时刻（ISO 字符串）持久化，服务重启后继续有效。
 */

const SHANGHAI_OFFSET_MINUTES = 8 * 60;
const WORK_START_MINUTES = 9 * 60;
const WORK_END_MINUTES = 18 * 60;
const WORK_MINUTES_PER_DAY = WORK_END_MINUTES - WORK_START_MINUTES;

export function loadCalendar(data) {
  const holidays = new Set();
  for (const group of data.holidays ?? []) {
    for (const date of group.dates ?? []) holidays.add(date);
  }
  const adjustedWorkdays = new Set((data.adjustedWorkdays ?? []).map((item) => item.date));
  return { holidays, adjustedWorkdays };
}

function toZonedParts(instant) {
  const ms = instant.getTime() + SHANGHAI_OFFSET_MINUTES * 60_000;
  const shifted = new Date(ms);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return {
    date: `${yyyy}-${mm}-${dd}`,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    yyyy,
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function zonedToInstant(yyyy, monthIndex, day, minutes) {
  const utcMs = Date.UTC(yyyy, monthIndex, day, 0, minutes - SHANGHAI_OFFSET_MINUTES);
  return new Date(utcMs);
}

export function isWorkday(calendar, instant) {
  const { date } = toZonedParts(instant);
  if (calendar.holidays.has(date)) return false;
  if (calendar.adjustedWorkdays.has(date)) return true;
  const day = instantWithOffset(instant).getUTCDay();
  return day !== 0 && day !== 6;
}

function instantWithOffset(instant) {
  return new Date(instant.getTime() + SHANGHAI_OFFSET_MINUTES * 60_000);
}

function nextDay(yyyy, monthIndex, day) {
  const d = new Date(Date.UTC(yyyy, monthIndex, day + 1));
  return { yyyy: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

/** 从 instant 所在或之后的第一个工作日 09:00 开始。 */
function firstWorkingMoment(calendar, instant) {
  let parts = toZonedParts(instant);
  let { yyyy, month, day } = parts;
  if (!isWorkday(calendar, instant)) {
    do {
      ({ yyyy, month, day } = nextDay(yyyy, month, day));
    } while (!isWorkday(calendar, zonedToInstant(yyyy, month, day, WORK_START_MINUTES)));
    return zonedToInstant(yyyy, month, day, WORK_START_MINUTES);
  }
  if (parts.minutes < WORK_START_MINUTES) {
    return zonedToInstant(yyyy, month, day, WORK_START_MINUTES);
  }
  if (parts.minutes >= WORK_END_MINUTES) {
    let n = nextDay(yyyy, month, day);
    while (!isWorkday(calendar, zonedToInstant(n.yyyy, n.month, n.day, WORK_START_MINUTES))) n = nextDay(n.yyyy, n.month, n.day);
    return zonedToInstant(n.yyyy, n.month, n.day, WORK_START_MINUTES);
  }
  return instant;
}

/**
 * 从 start 起增加 workingHours 个工作小时（仅工作日 09:00–18:00 之间流动）。
 * 返回绝对时刻 Date。
 */
export function addWorkingHours(calendar, start, workingHours) {
  let cursor = firstWorkingMoment(calendar, start);
  let remainingMinutes = Math.round(workingHours * 60);
  for (;;) {
    const parts = toZonedParts(cursor);
    const capacity = WORK_END_MINUTES - parts.minutes;
    if (remainingMinutes <= capacity) {
      return new Date(cursor.getTime() + remainingMinutes * 60_000);
    }
    remainingMinutes -= capacity;
    let { yyyy, month, day } = parts;
    let n = nextDay(yyyy, month, day);
    while (!isWorkday(calendar, zonedToInstant(n.yyyy, n.month, n.day, WORK_START_MINUTES))) n = nextDay(n.yyyy, n.month, n.day);
    cursor = zonedToInstant(n.yyyy, n.month, n.day, WORK_START_MINUTES);
  }
}

export function describeCalendarDay(calendar, instant) {
  const { date } = toZonedParts(instant);
  if (calendar.holidays.has(date)) return "holiday";
  if (calendar.adjustedWorkdays.has(date)) return "adjusted-workday";
  const day = instantWithOffset(instant).getUTCDay();
  return day === 0 || day === 6 ? "weekend" : "workday";
}
