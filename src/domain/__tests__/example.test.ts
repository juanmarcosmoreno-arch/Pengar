import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignMonths, exampleData, exampleDaily } from '../example';
import { importMonthlySheet, type Cell } from '../importSheet';
import { commitments, nextMonthOutlook } from '../installments';
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

  it('las tarjetas: lo comprometido de cada una, el margen del mes que viene y una desactualizada', () => {
    const res = importMonthlySheet(JSON.parse(readFileSync('public/ejemplo.json', 'utf8')) as Cell[][]);
    for (const day of ['2026-10-01', '2026-10-21', '2026-10-31', '2027-01-05']) {
      const data = exampleData(res, day);
      const c = commitments(data, { today: day });
      expect(c.cards.map((x) => [x.card, x.stale])).toEqual([['Itaú', false], ['OCA', false], ['Scotiabank', true]]);
      // El de la cuota en dólares lleva su cuenta
      expect(c.cards[0].plans.find((p) => p.usd)).toMatchObject({ merchant: 'Vuelos Celeste', usd: 100, rate: 40.1, amount: 4010 });
      // La 3/3 ya terminó
      expect(c.cards[0].plans.some((p) => p.merchant === 'Zapateria el Paso')).toBe(false);
      const o = nextMonthOutlook(data, { today: day });
      expect(o.income?.from).toBe('promedio');
      expect(o.installments).toBeGreaterThan(0);
      expect(o.margin).not.toBeNull();
    }
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
    // Los estados de cuenta anteriores de tres tarjetas, con sus cuotas
    expect(data.invoices.map((i) => [i.kind, i.card, i.date])).toEqual([['estado', 'OCA', '2027-03-25'], ['estado', 'Itaú', '2027-03-28'], ['estado', 'Scotiabank', '2027-02-15']]);
    // En lo que va de abril entró el sueldo y quedó plata
    const k = kpis(data, buildIndex(data), { from: '2027-04', to: '2027-04', includeSavings: false });
    expect(k.income).toBeGreaterThan(0);
    expect(k.balance).toBeGreaterThan(0);
  });
});
