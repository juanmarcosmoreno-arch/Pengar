import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { importMonthlySheet, type Cell } from '../importSheet';
import { dueMovements, newRecurring, pendingRecurring, recurringDate, suggestRecurring } from '../recurring';
import { emptyData, normalizeData } from '../template';
import type { Data, Movement, Recurring } from '../types';

const rubros = ['alquiler', 'ute', 'netflix', 'sueldo', 'super', 'regalos'].map((id) => ({ id, name: id, categoryId: 'c', keywords: [] }));

function rec(rubroId: string, day: number, extra: Partial<Recurring> = {}): Recurring {
  return { id: `rec-${rubroId}`, rubroId, kind: 'gasto', amount: 1000, day, createdAt: 0, ...extra };
}

let n = 0;
function mov(rubroId: string, date: string, amount: number, extra: Partial<Movement> = {}): Movement {
  return { id: `m${n++}`, rubroId, date, amount, kind: 'gasto', origin: 'manual', createdAt: 0, ...extra };
}

const base = (extra: Partial<Data>): Data => ({ ...emptyData(), rubros, ...extra });

describe('fijos pendientes', () => {
  const data = base({
    recurring: [
      rec('netflix', 20),
      rec('alquiler', 5, { amount: 24000 }),
      rec('ute', 10, { doneThrough: '2026-10' }),
      rec('sueldo', 1, { kind: 'ingreso', paused: true }),
      rec('super', 3),
    ],
    movements: [mov('super', '2026-10-02', 800)],
  });

  it('salen los no pausados sin anotar, ordenados por día, con su vencimiento', () => {
    const p = pendingRecurring(data, '2026-10', '2026-10-15');
    expect(p.map((r) => [r.rubroId, r.due])).toEqual([['alquiler', true], ['netflix', false]]);
  });
  it('un mes pasado vence entero; uno futuro todavía no', () => {
    expect(pendingRecurring(data, '2026-09', '2026-10-15').every((r) => r.due)).toBe(true);
    expect(pendingRecurring(data, '2026-09', '2026-10-15').map((r) => r.rubroId)).toEqual(['super', 'alquiler', 'netflix']);
    expect(pendingRecurring(data, '2026-11', '2026-10-15').some((r) => r.due)).toBe(false);
  });
  it('el día de hoy ya cuenta como vencido', () => {
    expect(pendingRecurring(data, '2026-10', '2026-10-20').find((r) => r.rubroId === 'netflix')!.due).toBe(true);
  });
  it('si el rubro ya tiene un movimiento en el mes, no se pide', () => {
    expect(pendingRecurring(data, '2026-10', '2026-10-15').some((r) => r.rubroId === 'super')).toBe(false);
    expect(pendingRecurring(data, '2026-11', '2026-11-15').some((r) => r.rubroId === 'super')).toBe(true);
  });
  it('los movimientos de los vencidos usan su día, sin pasar de hoy', () => {
    const due = dueMovements(data, '2026-10', '2026-10-15');
    expect(due.map((x) => [x.recurringId, x.movement.date, x.movement.amount, x.movement.origin])).toEqual([['rec-alquiler', '2026-10-05', 24000, 'manual']]);
    expect(recurringDate({ day: 20 }, '2026-10', '2026-10-15')).toBe('2026-10-15');
    expect(recurringDate({ day: 20 }, '2026-09', '2026-10-15')).toBe('2026-09-20');
  });
  it('un fijo nuevo empieza a pedirse este mes', () => {
    const r = newRecurring({ rubroId: 'ute', kind: 'gasto', amount: 5000, day: 31 }, '2026-01-10');
    expect(r.day).toBe(28);
    expect(r.doneThrough).toBe('2025-12');
  });
});

describe('fijos sugeridos', () => {
  // Seis meses completos antes de octubre: abril a setiembre
  const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const movements = [
    ...months.map((m, i) => mov('alquiler', `${m}-01`, 24000 + i, { monthly: true })),
    ...months.slice(1).flatMap((m) => [mov('ute', `${m}-09`, 2000), mov('ute', `${m}-11`, 1500)]),
    ...months.slice(2).map((m) => mov('regalos', `${m}-15`, 900)),
    ...months.map((m) => mov('sueldo', `${m}-01`, 150000, { kind: 'ingreso', monthly: true })),
    ...months.map((m) => mov('netflix', `${m}-20`, 500)),
    // Varía mucho de un mes a otro, o se anota compra por compra: no es un fijo
    ...months.map((m, i) => mov('regalos', `${m}-01`, i % 2 ? 300 : 5000, { monthly: true })),
    ...months.flatMap((m) => ['04', '12', '22'].map((d) => mov('super', `${m}-${d}`, 3000))),
    mov('super', '2026-10-03', 99999),
    mov('super', '2025-10-03', 99999),
  ];

  it('rubros estables en 5 de 6 meses, con el monto del último mes y el día del medio', () => {
    const s = suggestRecurring(base({ movements, recurring: [rec('netflix', 20)] }), '2026-10-20');
    expect(s.map((x) => x.rubroId)).toEqual(['sueldo', 'alquiler', 'ute']);
    expect(s[0]).toEqual({ rubroId: 'sueldo', kind: 'ingreso', amount: 150000, day: 1 });
    expect(s[1].amount).toBe(24005);
    expect(s[2]).toMatchObject({ amount: 3500, day: 10 });
  });
  it('como mucho 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: `r${i}`, categoryId: 'c', keywords: [] }));
    const ms = many.flatMap((r, i) => months.map((m) => mov(r.id, `${m}-01`, 100 + i)));
    const s = suggestRecurring({ ...emptyData(), rubros: many, movements: ms }, '2026-10-01');
    expect(s).toHaveLength(20);
    expect(s[0].amount).toBe(124);
  });
  it('con datos/ejemplo.xlsx sugiere el alquiler, UTE y Netflix', () => {
    const wb = XLSX.read(readFileSync('datos/ejemplo.xlsx'), { cellDates: true });
    const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets['presupuesto'], { header: 1, raw: true, defval: null });
    const res = importMonthlySheet(rows);
    const data: Data = { ...emptyData(), categories: res.categories, rubros: res.rubros, movements: res.movements };
    const names = suggestRecurring(data, '2026-10-20').map((x) => res.rubros.find((r) => r.id === x.rubroId)!.name);
    expect(names).toEqual(expect.arrayContaining(['Alquiler', 'UTE', 'Netflix', 'Entrada']));
    expect(names).toEqual(expect.arrayContaining(['Spotify', 'OSE', 'Emergencia móvil']));
    for (const variable of ['Paseos', 'Farmacia', 'Varios', 'Arreglos casa']) expect(names).not.toContain(variable);
  });
});

describe('datos de versiones anteriores', () => {
  it('normalizeData completa lo que falta', () => {
    const old = { version: 1, categories: [{ id: 'c', name: 'Casa', kind: 'gasto', icon: 'home', color: '#000', budget: { type: 'none' }, order: 0 }], rubros, movements: [], invoices: [], goals: [], settings: { name: 'Ana', onboarded: true } } as unknown as Data;
    const d = normalizeData(old);
    expect(d.recurring).toEqual([]);
    expect(d.categories[0].icon).toBe('m:vivienda');
    expect(d.settings.currency.symbol).toBe('$');
    expect(d.settings.learned).toEqual({});
    expect(d.settings.name).toBe('Ana');
  });
});
