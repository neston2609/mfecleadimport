function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function nextRenewalPeriod(expiryDate: string): {
  effectiveDate: string;
  expiryDate: string;
} {
  const [year, month, day] = expiryDate.split("-").map(Number);
  const nextStart = new Date(Date.UTC(year, month - 1, day + 1));
  const lastDayNextYear = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  const nextExpiry = new Date(
    Date.UTC(year + 1, month - 1, Math.min(day, lastDayNextYear)),
  );
  return {
    effectiveDate: isoDate(nextStart),
    expiryDate: isoDate(nextExpiry),
  };
}
