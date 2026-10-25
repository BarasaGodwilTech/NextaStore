/**
 * Working-day clock for payouts ("paid within 2 working days").
 * Pure functions, no dependencies. Everything is computed in East Africa Time
 * (UTC+3, no DST) by shifting the instant, so it behaves the same on any server TZ.
 */
const { EAT_OFFSET_HOURS, FIXED_HOLIDAYS_MMDD, MOVABLE_HOLIDAYS, WITHDRAWAL } = require('./rules');

const HOUR = 3600 * 1000;

/** The wall clock in Kampala, expressed as a UTC-shaped Date (read it with getUTC*). */
function toEat(date) { return new Date(new Date(date).getTime() + EAT_OFFSET_HOURS * HOUR); }
function fromEat(eatDate) { return new Date(eatDate.getTime() - EAT_OFFSET_HOURS * HOUR); }

function ymd(eat) {
    const m = String(eat.getUTCMonth() + 1).padStart(2, '0');
    const d = String(eat.getUTCDate()).padStart(2, '0');
    return `${eat.getUTCFullYear()}-${m}-${d}`;
}

function isWorkingDay(eat, extraHolidays = []) {
    const dow = eat.getUTCDay(); // 0 Sun .. 6 Sat
    if (dow === 0 || dow === 6) return false;
    const key = ymd(eat);
    if (FIXED_HOLIDAYS_MMDD.includes(key.slice(5))) return false;
    return !(MOVABLE_HOLIDAYS.includes(key) || extraHolidays.includes(key));
}

function nextWorkingDay(eat, extraHolidays = []) {
    const d = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate() + 1));
    while (!isWorkingDay(d, extraHolidays)) d.setUTCDate(d.getUTCDate() + 1);
    return d;
}

/**
 * When must a withdrawal requested at `requestedAt` be paid?
 *   - Counting starts on the request day if it is a working day AND before the 15:00 EAT cut-off,
 *     otherwise on the next working day.
 *   - The deadline is `payWithinWorkingDays` working days after that start day, at 17:00 EAT.
 * Mon 10:00 -> Wed 17:00.  Mon 16:00 -> Thu 17:00.  Fri 11:00 -> Tue 17:00.  Sat -> Wed 17:00.
 */
function payoutDueBy(requestedAt, extraHolidays = []) {
    const eat = toEat(requestedAt);
    let start = new Date(Date.UTC(eat.getUTCFullYear(), eat.getUTCMonth(), eat.getUTCDate()));
    const afterCutoff = eat.getUTCHours() >= WITHDRAWAL.dailyCutoffHourEAT;
    if (!isWorkingDay(start, extraHolidays) || afterCutoff) start = nextWorkingDay(start, extraHolidays);
    let due = start;
    for (let i = 0; i < WITHDRAWAL.payWithinWorkingDays; i++) due = nextWorkingDay(due, extraHolidays);
    due.setUTCHours(WITHDRAWAL.payByHourEAT, 0, 0, 0);
    return fromEat(due);
}

function isOverdue(dueBy, now = new Date()) { return new Date(now).getTime() > new Date(dueBy).getTime(); }

/** "Tue 14 Oct, 5:00 pm" in Kampala time, for notifications and dashboards. */
function formatDueBy(dueBy) {
    const e = toEat(dueBy);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const h = e.getUTCHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${days[e.getUTCDay()]} ${e.getUTCDate()} ${months[e.getUTCMonth()]}, ${h12}:${String(e.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

module.exports = { toEat, fromEat, isWorkingDay, nextWorkingDay, payoutDueBy, isOverdue, formatDueBy };
