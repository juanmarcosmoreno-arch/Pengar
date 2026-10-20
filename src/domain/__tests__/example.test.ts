import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignMonths, exampleData, exampleDaily } from '../example';
import { importMonthlySheet, type Cell } from '../importSheet';
import { buildIndex, kpis } from '../stats';
import { templateData } from '../template';

describe('datos de ejemplo', () => {
  const { rubros } = templateData();
  const nameOf = (id: string) => rubros.find((r) => r.id === id)?.name;

  it('anota movimientos del mes en días hasta hoy, con los rubros que existen', () => {
    const list = exampleDaily(rubros, '2026-10-20');
    expect(list.length).toBeGreaterThanOrEqual(8);
    for (const m of list) {
      expect(m.date >= '2026-10-01' && m.date <= '2026-10-20').toBe(true);
      expect(m.origin).toBe('manual');
      expect(m.monthly).toBeUndefined();
      expect(m.amount).toBeGreaterThan(0);
      expect(nameOf(m.rubroId)).toBeTruthy();
    }
    // La plantilla no tiene «UTE» pero sí «Luz»; el último cae hoy
    expect(list.some((m) => nameOf(m.rubroId) === 'Luz')).toBe(true);
    expect(list.some((m) => m.date === '2026-10-20')).toBe(true);
    expect(list.find((m) => nameOf(m.rubroId) === 'Sueldo')?.kind).toBe('ingreso');
    expect(list.some((m) => m.merchant) && list.some((m) => m.note)).toBe(true);
  });

  it('el primer día del mes, todo cae ese día; sin el rubro, se omite', () => {
    expect(exampleDaily(rubros, '2026-11-01').every((m) => m.date === '2026-11-01')).toBe(true);
    const onlySuper = rubros.filter((r) => r.name === 'Supermercado');
    expect(exampleDaily(onlySuper, '2026-11-15').map((m) => nameOf(m.rubroId))).toEqual(['Supermercado', 'Supermercado']);
  });

  it('corre los meses de la planilla hasta el mes pasado y suma lo de este mes', () => {
    const res = importMonthlySheet(JSON.parse(readFileSync('public/ejemplo.json', 'utf8')) as Cell[][]);
    expect(alignMonths(res.movements, '2027-03').map((m) => m.date).sort().at(-1)).toBe('2027-03-01');
    const data = exampleData(res, '2027-04-10');
    const months = data.movements.filter((m) => m.monthly).map((m) => m.date.slice(0, 7));
    expect(months.sort().at(-1)).toBe('2027-03');
    expect(new Set(months).size).toBe(res.months.length);
    expect(data.settings).toMatchObject({ name: 'Ana', onboarded: true, example: true });
    expect(data.goals).toMatchObject([{ name: 'Vacaciones', target: 60000, saved: 18000 }]);
    // En lo que va de abril entró el sueldo y quedó plata
    const k = kpis(data, buildIndex(data), { from: '2027-04', to: '2027-04', includeSavings: false });
    expect(k.income).toBeGreaterThan(0);
    expect(k.balance).toBeGreaterThan(0);
  });
});
