/** Datos de ejemplo (inventados): para mirar la app sin cargar nada y para la vista previa web. */
import { addMonths, monthOf } from './dates';
import { norm, type ImportResult } from './importSheet';
import { defaultSettings, newId, normalizeData } from './template';
import type { Data, Kind, Movement, Rubro } from './types';

interface DailyExample {
  /** Nombres posibles del rubro: se usa el primero que exista */
  rubro: string[];
  /** Día en un mes de 28; se acomoda para que el último caiga hoy */
  day: number;
  amount: number;
  kind?: Kind;
  merchant?: string;
  note?: string;
}

const DAILY: DailyExample[] = [
  { rubro: ['Sueldo', 'Entrada'], day: 1, amount: 186400, kind: 'ingreso' },
  { rubro: ['Alquiler'], day: 2, amount: 24000, note: 'Transferencia a la inmobiliaria' },
  { rubro: ['Ahorro'], day: 3, amount: 25000, note: 'A la caja de ahorro' },
  { rubro: ['Supermercado'], day: 4, amount: 3870, merchant: 'Tienda Inglesa' },
  { rubro: ['Feria'], day: 7, amount: 1150, note: 'Feria del domingo' },
  { rubro: ['Combustible'], day: 9, amount: 2300, merchant: 'ANCAP' },
  { rubro: ['UTE', 'Luz'], day: 11, amount: 4980 },
  { rubro: ['Carnicería'], day: 14, amount: 1640 },
  { rubro: ['Farmacia'], day: 17, amount: 690, merchant: 'Farmashop' },
  { rubro: ['Comer afuera'], day: 20, amount: 1480, note: 'Pizza con amigos' },
  { rubro: ['Supermercado'], day: 23, amount: 2250, merchant: 'Disco' },
  { rubro: ['Combustible'], day: 26, amount: 2100 },
  { rubro: ['Comer afuera'], day: 28, amount: 640, merchant: 'Café de la esquina' },
];

/** Movimientos anotados a mano en lo que va del mes (días hasta hoy). Los rubros que no existan se omiten. */
export function exampleDaily(rubros: Rubro[], todayISO: string): Movement[] {
  const month = monthOf(todayISO);
  const todayDay = Number(todayISO.slice(8, 10));
  const find = (names: string[]) => {
    for (const n of names) {
      const r = rubros.find((x) => !x.archived && norm(x.name) === norm(n));
      if (r) return r;
    }
  };
  const out: Movement[] = [];
  DAILY.forEach((e, i) => {
    const rubro = find(e.rubro);
    if (!rubro) return;
    const day = Math.max(1, Math.ceil((e.day / 28) * todayDay));
    const date = `${month}-${String(day).padStart(2, '0')}`;
    out.push({
      id: newId('m'),
      date,
      amount: e.amount,
      kind: e.kind ?? 'gasto',
      rubroId: rubro.id,
      merchant: e.merchant,
      note: e.note,
      origin: 'manual',
      // En orden de anotación, para que los del mismo día salgan como en la lista
      createdAt: new Date(`${date}T12:00:00`).getTime() + i,
    });
  });
  return out;
}

const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

/** Corre los meses de una planilla para que el último sea `lastMonth`: así el ejemplo siempre llega hasta el mes pasado */
export function alignMonths(movements: Movement[], lastMonth: string): Movement[] {
  if (!movements.length) return movements;
  const last = movements.reduce((m, x) => (monthOf(x.date) > m ? monthOf(x.date) : m), '');
  const shift = monthIndex(lastMonth) - monthIndex(last);
  if (!shift) return movements;
  return movements.map((m) => {
    const day = Math.min(28, Number(m.date.slice(8, 10)) || 1);
    return { ...m, date: `${addMonths(monthOf(m.date), shift)}-${String(day).padStart(2, '0')}` };
  });
}

/** Todo el ejemplo: la planilla importada (hasta el mes pasado), lo anotado este mes, una meta y «Ana» */
export function exampleData(res: Pick<ImportResult, 'categories' | 'rubros' | 'movements'>, todayISO: string): Data {
  return normalizeData({
    categories: res.categories,
    rubros: res.rubros,
    movements: [...alignMonths(res.movements, addMonths(monthOf(todayISO), -1)), ...exampleDaily(res.rubros, todayISO)],
    goals: [{ id: newId('g'), name: 'Vacaciones', icon: 'm:viajes', target: 60000, saved: 18000 }],
    settings: { ...defaultSettings(), name: 'Ana', onboarded: true, example: true },
  });
}
