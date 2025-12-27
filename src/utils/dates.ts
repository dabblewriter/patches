/**
 * Date utility functions for creating and manipulating ISO 8601 timestamps.
 *
 * Client-side timestamps use local timezone offsets (e.g., +04:00).
 * Server-side timestamps use UTC with Z suffix.
 */

/**
 * Creates an ISO string with local timezone offset for client dates.
 * Example: "2025-12-26T14:00:00.000+04:00"
 */
export function createClientTimestamp(): string {
  const now = new Date();
  return formatDateWithOffset(now, getLocalTimezoneOffset());
}

/**
 * Creates an ISO string with Z suffix for server dates.
 * Example: "2025-12-26T10:00:00.000Z"
 */
export function createServerTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Parses an ISO string to a Date for comparisons.
 */
export function parseTimestamp(iso: string): Date {
  return new Date(iso);
}

/**
 * Calculates milliseconds between two ISO timestamps.
 * Returns (a - b) in milliseconds.
 */
export function timestampDiff(a: string, b: string): number {
  return new Date(a).getTime() - new Date(b).getTime();
}

/**
 * Extracts the timezone offset string from an ISO timestamp.
 * Returns "+04:00", "-05:00", or "Z".
 */
export function extractTimezoneOffset(iso: string): string {
  const match = iso.match(/([+-]\d{2}:\d{2}|Z)$/);
  return match ? match[1] : 'Z';
}

/**
 * Clamps a timestamp to not exceed a limit, preserving the original timezone offset.
 * Returns the original if it's <= limit, otherwise returns limit in original's timezone.
 *
 * Example:
 *   timestamp: "2025-12-26T18:00:00.000+04:00" (future)
 *   limit:     "2025-12-26T10:00:00.000Z"      (server time)
 *   result:    "2025-12-26T14:00:00.000+04:00" (clamped, same instant as limit)
 */
export function clampTimestamp(timestamp: string, limit: string): string {
  const timestampDate = new Date(timestamp);
  const limitDate = new Date(limit);

  if (timestampDate <= limitDate) {
    return timestamp;
  }

  // Clamp to limit but preserve original timezone offset
  const offset = extractTimezoneOffset(timestamp);
  return formatDateWithOffset(limitDate, offset);
}

/**
 * Formats a Date with a specific timezone offset string.
 * The date is adjusted to display the correct local time for that offset.
 */
export function formatDateWithOffset(date: Date, offset: string): string {
  if (offset === 'Z') {
    return date.toISOString();
  }

  // Parse offset to get total minutes
  const match = offset.match(/([+-])(\d{2}):(\d{2})/);
  if (!match) return date.toISOString();

  const sign = match[1] === '+' ? 1 : -1;
  const offsetMinutes = sign * (parseInt(match[2]) * 60 + parseInt(match[3]));

  // Adjust date by offset to get local time representation
  const localDate = new Date(date.getTime() + offsetMinutes * 60 * 1000);

  // Format as ISO without Z, then append offset
  const iso = localDate.toISOString();
  return iso.slice(0, -1) + offset;
}

/**
 * Gets the local timezone offset string for the current environment.
 * Returns "+04:00", "-05:00", or "Z" for UTC.
 */
export function getLocalTimezoneOffset(): string {
  const offset = -new Date().getTimezoneOffset();
  if (offset === 0) return 'Z';
  const hours = Math.floor(Math.abs(offset) / 60);
  const mins = Math.abs(offset) % 60;
  const sign = offset >= 0 ? '+' : '-';
  return `${sign}${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}
