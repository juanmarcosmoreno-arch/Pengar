import { describe, expect, it } from 'vitest';
import { shiftMonths, sinceDay, timeAgo } from '../dates';

describe('cuánto pasó (hogar compartido)', () => {
  const now = new Date('2026-10-21T15:00:00').getTime();
  const min = 60_000;
  it('«Sincronizado hace 1 min»', () => {
    expect(timeAgo(now - 20_000, now)).toBe('hace un momento');
    expect(timeAgo(now + 5_000, now)).toBe('hace un momento');
    expect(timeAgo(now - min, now)).toBe('hace 1 min');
    expect(timeAgo(now - 59 * min, now)).toBe('hace 59 min');
    expect(timeAgo(now - 3 * 60 * min, now)).toBe('hace 3 h');
    expect(timeAgo(new Date('2026-10-20T08:00:00').getTime(), now)).toBe('ayer');
    expect(timeAgo(new Date('2026-10-18T08:00:00').getTime(), now)).toBe('el 18/10');
  });

  it('integrantes «desde…»', () => {
    expect(sinceDay('2026-10-21', '2026-10-21')).toBe('desde hoy');
    expect(sinceDay('2026-10-20', '2026-10-21')).toBe('desde ayer');
    expect(sinceDay('2026-10-12', '2026-10-21')).toBe('desde el lunes 12 de octubre');
    expect(sinceDay('2025-12-01', '2026-10-21')).toBe('desde el lunes 1 de diciembre de 2025');
  });
});

describe('el mismo día otro mes', () => {
  it('sin pasarse del último día del mes', () => {
    expect(shiftMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(shiftMonths('2028-03-31', -1)).toBe('2028-02-29');
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(shiftMonths('2026-01-10', -1)).toBe('2025-12-10');
  });
});
