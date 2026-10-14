import { alerts, todayISO } from './domain.js';

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  enabled: false, payment: true, contract: true, review: true,
  daysBefore: 2, onDueDate: true, repeatDays: 2, hour: 9,
});

/** Settings are personal. Invalid values fall back to an opt-out configuration. */
export function notificationPreferences(value = {}) {
  const defaults = DEFAULT_NOTIFICATION_PREFERENCES;
  const result = { ...defaults };
  for (const field of ['enabled', 'payment', 'contract', 'review', 'onDueDate']) {
    if (typeof value?.[field] === 'boolean') result[field] = value[field];
  }
  for (const [field, maximum] of [['daysBefore', 30], ['repeatDays', 30], ['hour', 23]]) {
    if (Number.isInteger(value?.[field]) && value[field] >= 0 && value[field] <= maximum) result[field] = value[field];
  }
  return result;
}

function calendarDay(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? time / 86_400_000 : null;
}

/** Matches calendar days, so DST does not move reminders or repeat intervals. */
export function shouldRemindOn(date, preferences, today = todayISO()) {
  const due = calendarDay(date);
  const current = calendarDay(today);
  if (due === null || current === null) return false;
  const options = notificationPreferences(preferences);
  const days = due - current;
  if (days > 0) return options.daysBefore > 0 && days === options.daysBefore;
  if (days === 0) return options.onDueDate;
  return options.repeatDays > 0 && (-days) % options.repeatDays === 0;
}

/** Reuses invoice/contract rules: paid, draft, rejected and duplicated contracts are excluded. */
export function notificationCandidates(state, preferences, today = todayISO()) {
  const options = notificationPreferences(preferences);
  const current = calendarDay(today);
  if (!options.enabled || current === null) return [];
  const horizon = new Date((current + options.daysBefore) * 86_400_000).toISOString().slice(0, 10);
  return alerts(state?.documents, state?.payments, horizon).filter((alert) =>
    options[alert.type] === true && shouldRemindOn(alert.date, options, today));
}

export function notificationDeliveryHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23',
  }).format(now));
}

/** Only an opaque day/count leaves the app; no client, invoice number or amount. */
export function privatePushPayload(today, count) {
  if (calendarDay(today) === null || !Number.isSafeInteger(count) || count < 1 || count > 30_000) {
    throw new Error('Invalid reminder summary');
  }
  return { kind: 'orquivia-reminder', day: today, count, url: './?view=alerts' };
}
