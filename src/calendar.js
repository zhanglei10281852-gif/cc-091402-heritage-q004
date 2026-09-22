// 工作日历：截止时间只在工作日 09:00-17:00（Asia/Shanghai）内流逝。
// 节假日、调休上班日来自 reference/work-calendar.json，时间戳为绝对时刻，重启后不重算。

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

function shanghaiDayParts(date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function dayKey(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function shanghaiDayKey(date) {
  const p = shanghaiDayParts(date);
  return dayKey(p.year, p.month, p.day);
}

// 某天的 09:00 / 17:00（上海时间）对应的绝对时刻
function workBoundary(date, hour) {
  const p = shanghaiDayParts(date);
  const utc = Date.UTC(p.year, p.month - 1, p.day, hour, 0, 0);
  return new Date(utc - SHANGHAI_OFFSET_MS);
}

function addCalendarDays(date, n) {
  const p = shanghaiDayParts(date);
  const utc = Date.UTC(p.year, p.month - 1, p.day + n, 9, 0, 0);
  return new Date(utc - SHANGHAI_OFFSET_MS);
}

export class WorkCalendar {
  constructor(config) {
    this.timezone = config.timezone;
    this.workingWeekdays = new Set(config.workingDays);
    this.holidays = new Set(config.holidays);
    this.extraWorkdays = new Set(config.extraWorkdays);
    const [startHour, startMinute] = config.workingHours.start.split(":").map(Number);
    const [endHour, endMinute] = config.workingHours.end.split(":").map(Number);
    this.startMinutes = startHour * 60 + startMinute;
    this.endMinutes = endHour * 60 + endMinute;
  }

  isWorkday(date) {
    const key = shanghaiDayKey(date);
    if (this.holidays.has(key)) return false;
    if (this.extraWorkdays.has(key)) return true;
    return this.workingWeekdays.has(shanghaiDayParts(date).weekday);
  }

  startOfWorkday(date) {
    return workBoundary(date, this.startMinutes / 60);
  }

  endOfWorkday(date) {
    return workBoundary(date, this.endMinutes / 60);
  }

  nextWorkdayStart(date) {
    let candidate = addCalendarDays(date, 1);
    let guard = 0;
    while (!this.isWorkday(candidate)) {
      candidate = addCalendarDays(candidate, 1);
      if (++guard > 366) throw new Error("calendar: no workday within 366 days");
    }
    return this.startOfWorkday(candidate);
  }

  isWithinWorkingHours(date) {
    if (!this.isWorkday(date)) return false;
    const p = shanghaiDayParts(date);
    const minutes = p.hour * 60 + p.minute;
    return minutes >= this.startMinutes && minutes < this.endMinutes;
  }

  // 从 from 起累加 workingHours 个工作小时，非工作时段直接跳过
  addWorkingHours(from, workingHours) {
    let cursor = new Date(from.getTime());
    let remainingMs = workingHours * 60 * 60 * 1000;
    let guard = 0;

    while (remainingMs > 0) {
      if (++guard > 1000) throw new Error("calendar: deadline computation exceeded bounds");
      if (!this.isWorkday(cursor)) {
        cursor = this.nextWorkdayStart(cursor);
        continue;
      }
      const start = this.startOfWorkday(cursor);
      const end = this.endOfWorkday(cursor);
      if (cursor.getTime() < start.getTime()) cursor = start;
      if (cursor.getTime() >= end.getTime()) {
        cursor = this.nextWorkdayStart(cursor);
        continue;
      }
      const available = end.getTime() - cursor.getTime();
      if (remainingMs <= available) return new Date(cursor.getTime() + remainingMs);
      remainingMs -= available;
      cursor = this.nextWorkdayStart(cursor);
    }
    return cursor;
  }

  isOverdue(deadline, now) {
    return deadline.getTime() <= now.getTime();
  }
}
