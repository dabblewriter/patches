/**
 * Date utility functions for creating and manipulating ISO 8601 timestamps.
 *
 * Client-side timestamps use local timezone offsets (e.g., +04:00).
 * Server-side timestamps use UTC with Z suffix.
 */

/**
 * Converts a Date or ISO string to UTC format without milliseconds.
 * Example: "2025-12-26T10:00:00Z"
 */
export function getISO(date: Date | string = new Date()): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().replace(/\.\d{3}/, '');
}

/**
 * Formats a Date with a specific timezone offset string.
 * The date is adjusted to display the correct local time for that offset.
 */
export function getLocalISO(date: Date | string = new Date(), offset: string = getLocalTimezoneOffset()): string {
  // Parse offset to get total minutes
  const match = offset.match(/([+-])(\d{2}):(\d{2})/);
  if (offset === 'Z' || !match) return getISO(date);
  const sign = match[1] === '+' ? 1 : -1;
  const offsetMinutes = sign * (parseInt(match[2]) * 60 + parseInt(match[3]));

  // Adjust date by offset to get local time representation
  const localDate = new Date((typeof date === 'string' ? new Date(date) : date).getTime() + offsetMinutes * 60 * 1000);

  // Format as ISO without Z, then append offset
  return getISO(localDate).slice(0, -1) + offset;
}

/**
 * Calculates milliseconds between two ISO timestamps.
 * Returns (a - b) in milliseconds.
 */
export function timestampDiff(a: string, b: string): number {
  return new Date(a).getTime() - new Date(b).getTime();
}

/**
 * Clamps a timestamp to not exceed a limit, preserving the original timezone offset.
 * Returns the original if it's <= limit, otherwise returns limit in original's timezone.
 *
 * Example:
 *   timestamp: "2025-12-26T18:00:00+04:00" (future)
 *   limit:     "2025-12-26T10:00:00Z"      (server time)
 *   result:    "2025-12-26T14:00:00+04:00" (clamped, same instant as limit)
 */
export function clampTimestamp(timestamp: string, limit: string): string {
  if (!timestamp || !limit) throw new Error('Timestamp and limit are required');
  const timestampDate = new Date(timestamp);
  const limitDate = new Date(limit);

  if (timestampDate <= limitDate) {
    return timestamp;
  }

  // Clamp to limit but preserve original timezone offset
  const offset = extractTimezoneOffset(timestamp);
  return getLocalISO(limitDate, offset);
}

/**
 * Extracts the timezone offset string from an ISO timestamp.
 * Returns "+04:00", "-05:00", or "Z".
 */
export function extractTimezoneOffset(iso: string): string {
  if (!iso) return 'Z';
  const match = iso.match(/([+-]\d{2}:\d{2}|Z)$/);
  return match ? match[1] : 'Z';
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
