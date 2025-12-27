import { describe, expect, it } from 'vitest';
import {
  clampTimestamp,
  extractTimezoneOffset,
  getISO,
  getLocalISO,
  getLocalTimezoneOffset,
  timestampDiff,
} from '../../src/utils/dates';

describe('Date Utilities', () => {
  describe('createServerTimestamp', () => {
    it('should return ISO string with Z suffix and no milliseconds', () => {
      const timestamp = getISO();

      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(timestamp).not.toContain('.');
    });
  });

  describe('createClientTimestamp', () => {
    it('should return ISO string with timezone offset and no milliseconds', () => {
      const timestamp = getLocalISO();

      // Should match either Z or +/-HH:MM format, no milliseconds
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$/);
      expect(timestamp).not.toContain('.');
    });
  });

  describe('toISO', () => {
    it('should convert Date to UTC without milliseconds', () => {
      const date = new Date('2025-12-26T14:30:45.123Z');
      const result = getISO(date);

      expect(result).toBe('2025-12-26T14:30:45Z');
    });

    it('should convert ISO string to UTC without milliseconds', () => {
      const result = getISO('2025-12-26T10:30:45.999+04:00');

      // 10:30 +04:00 = 06:30 UTC
      expect(result).toBe('2025-12-26T06:30:45Z');
    });

    it('should default to current time when no argument provided', () => {
      const before = Date.now();
      const result = getISO();
      const after = Date.now();

      // Should be a valid ISO string without milliseconds
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

      // Should be between before and after
      const resultTime = new Date(result).getTime();
      expect(resultTime).toBeGreaterThanOrEqual(before - 1000); // 1s tolerance for rounding
      expect(resultTime).toBeLessThanOrEqual(after + 1000);
    });
  });

  describe('formatDateWithOffset', () => {
    it('should format with Z offset without milliseconds', () => {
      const date = new Date('2025-12-26T10:00:00.500Z');
      const result = getLocalISO(date, 'Z');

      expect(result).toBe('2025-12-26T10:00:00Z');
    });

    it('should format with positive offset without milliseconds', () => {
      const date = new Date('2025-12-26T10:00:00.500Z');
      const result = getLocalISO(date, '+04:00');

      // 10:00 UTC displayed as 14:00 +04:00
      expect(result).toBe('2025-12-26T14:00:00+04:00');
    });

    it('should format with negative offset without milliseconds', () => {
      const date = new Date('2025-12-26T10:00:00.500Z');
      const result = getLocalISO(date, '-05:00');

      // 10:00 UTC displayed as 05:00 -05:00
      expect(result).toBe('2025-12-26T05:00:00-05:00');
    });
  });

  describe('extractTimezoneOffset', () => {
    it('should extract Z suffix', () => {
      expect(extractTimezoneOffset('2025-12-26T10:00:00Z')).toBe('Z');
    });

    it('should extract positive offset', () => {
      expect(extractTimezoneOffset('2025-12-26T14:00:00+04:00')).toBe('+04:00');
    });

    it('should extract negative offset', () => {
      expect(extractTimezoneOffset('2025-12-26T05:00:00-05:00')).toBe('-05:00');
    });

    it('should default to Z for invalid format', () => {
      expect(extractTimezoneOffset('invalid')).toBe('Z');
    });
  });

  describe('clampTimestamp', () => {
    it('should return original if within limit', () => {
      const timestamp = '2025-12-26T10:00:00+04:00';
      const limit = '2025-12-26T10:00:00Z'; // Same instant in UTC

      const result = clampTimestamp(timestamp, limit);
      expect(result).toBe(timestamp);
    });

    it('should clamp to limit while preserving timezone', () => {
      // Client sends future timestamp
      const timestamp = '2025-12-26T18:00:00+04:00'; // 14:00 UTC
      const limit = '2025-12-26T10:00:00Z'; // Server time

      const result = clampTimestamp(timestamp, limit);

      // Should be clamped to 10:00 UTC but in +04:00 timezone = 14:00
      expect(result).toBe('2025-12-26T14:00:00+04:00');
    });
  });

  describe('timestampDiff', () => {
    it('should calculate difference in milliseconds', () => {
      const a = '2025-12-26T10:00:05Z';
      const b = '2025-12-26T10:00:00Z';

      expect(timestampDiff(a, b)).toBe(5000);
    });

    it('should handle different timezone formats', () => {
      const a = '2025-12-26T14:00:00+04:00'; // 10:00 UTC
      const b = '2025-12-26T10:00:00Z'; // 10:00 UTC

      expect(timestampDiff(a, b)).toBe(0);
    });
  });

  describe('getLocalTimezoneOffset', () => {
    it('should return valid timezone offset format', () => {
      const offset = getLocalTimezoneOffset();

      expect(offset).toMatch(/^([+-]\d{2}:\d{2}|Z)$/);
    });
  });
});
