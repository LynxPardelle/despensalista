const DAY_IN_MS = 24 * 60 * 60 * 1000;
const mexicoCityCalendar = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Mexico_City',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Date-only values are persisted as UTC midnight labels, not as local instants.
export function utcDateLabel(value: Date): Date {
  return utcMidnight(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
  );
}

export function mexicoCityDateLabel(instant: Date): Date {
  const parts = mexicoCityCalendar.formatToParts(instant);
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);

  return utcMidnight(part('year'), part('month') - 1, part('day'));
}

export function civilDayDifference(
  referenceInstant: Date,
  targetDateLabel: Date,
): number {
  return (
    (utcDateLabel(targetDateLabel).getTime() -
      mexicoCityDateLabel(referenceInstant).getTime()) /
    DAY_IN_MS
  );
}

export function addCivilDays(dateLabel: Date, days: number): Date {
  const result = utcDateLabel(dateLabel);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function addCivilMonths(dateLabel: Date, months: number): Date {
  const anchor = utcDateLabel(dateLabel);
  const firstOfTargetMonth = utcMidnight(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth() + months,
    1,
  );
  const lastDayOfTargetMonth = utcMidnight(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth() + 1,
    0,
  ).getUTCDate();

  return utcMidnight(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth(),
    Math.min(anchor.getUTCDate(), lastDayOfTargetMonth),
  );
}

export function isSupportedCivilDateLabel(value: Date): boolean {
  const year = value.getUTCFullYear();
  return Number.isFinite(value.getTime()) && year >= 1 && year <= 9999;
}

function utcMidnight(year: number, monthIndex: number, day: number): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, monthIndex, day);
  result.setUTCHours(0, 0, 0, 0);
  return result;
}
