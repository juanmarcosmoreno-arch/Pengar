/** Datos de ejemplo (inventados): para mirar la app sin cargar nada y para la vista previa web. */
import { addMonths, monthOf } from './dates';
import { parseAmount } from './money';
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

/**
 * El ejemplo guardado se armó para un mes que ya pasó (alguien lo miró, cambió algo y volvió otro mes): el mes en curso
 * quedaría vacío. Hay que volver a armarlo.
 */
export function exampleOutdated(d: Pick<Data, 'movements' | 'settings'>, todayISO: string): boolean {
  if (!d.settings.example || !d.movements.length) return false;
  const last = d.movements.reduce((m, x) => (monthOf(x.date) > m ? monthOf(x.date) : m), '');
  return last < monthOf(todayISO);
}

interface StatementExample {
  /** Día del mes: en el mes anterior tal cual; en este mes, acomodado hasta hoy (como DAILY) */
  day: number;
  prev?: boolean;
  text: string;
  /** Como viene en el estado de cuenta («-» para pagos y créditos, «U$S» para dólares) */
  amount: string;
}

/**
 * Compras del estado de cuenta de ejemplo. Algunos comercios coinciden con las palabras de los rubros del ejemplo
 * (Tienda Inglesa, Farmashop, Netflix…) y otros son nuevos; Tienda Inglesa del 4 y Farmashop del 17 ya están
 * anotados en DAILY (posibles repetidos).
 */
const STATEMENT: StatementExample[] = [
  { prev: true, day: 26, text: 'SALDO ANTERIOR', amount: '21.540,00' },
  { prev: true, day: 27, text: 'TIENDA INGLESA SUC 12 MONTEVIDEO', amount: '2.418,30' },
  { prev: true, day: 28, text: 'MERCADOPAGO*LA PASIVA', amount: '890,00' },
  { day: 2, text: 'SU PAGO - GRACIAS', amount: '-21.540,00' },
  { day: 4, text: 'TIENDA INGLESA 7', amount: '3.870,00' },
  { day: 5, text: 'NETFLIX.COM', amount: 'U$S 12,99' },
  { day: 6, text: 'PANADERIA LA ESPIGA', amount: '585,00' },
  { day: 8, text: 'DLO*UBER TRIP', amount: '312,00' },
  { day: 10, text: 'ZARA 18 DE JULIO', amount: '3.290,00' },
  { day: 11, text: 'FARMASHOP 14 CUOTA 02/03', amount: '1.500,00' },
  { day: 12, text: 'MOVIE CENTER', amount: '980,00' },
  { day: 13, text: 'MERCADOPAGO*LA PASIVA', amount: '760,00' },
  { day: 14, text: 'TIENDA INGLESA 7', amount: '1.236,40' },
  { day: 15, text: 'FERRETERIA EL TORNILLO', amount: '1.380,00' },
  { day: 16, text: 'REINTEGRO IVA LEY 19210', amount: '-48,60' },
  { day: 17, text: 'FARMASHOP 3', amount: '690,00' },
  { day: 18, text: 'PEDIDOSYA*BURGER KING', amount: '715,00' },
  { day: 19, text: 'DLO*UBER TRIP', amount: '268,00' },
  { day: 21, text: 'SPOTIFY P2A4B6C8', amount: 'U$S 4,99' },
  { day: 24, text: 'PANADERIA LA ESPIGA', amount: '420,00' },
];

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Estado de cuenta de ejemplo (OCA, en texto como lo lee el PDF), del 26 del mes pasado a hoy: para probar «Tarjeta»
 * con los datos de ejemplo. Trae compras conocidas y nuevas, un pago, el reintegro de IVA, compras en dólares y una cuota.
 */
export function exampleStatementText(todayISO: string): string {
  const month = monthOf(todayISO);
  const prev = addMonths(month, -1);
  const todayDay = Number(todayISO.slice(8, 10));
  const due = new Date(Date.UTC(+todayISO.slice(0, 4), +todayISO.slice(5, 7) - 1, todayDay + 15)).toISOString().slice(0, 10);
  const rows = STATEMENT.map((e) => {
    const day = e.prev ? e.day : Math.max(1, Math.ceil((e.day / 28) * todayDay));
    const date = `${e.prev ? prev : month}-${String(day).padStart(2, '0')}`;
    return `${date.slice(8, 10)}/${date.slice(5, 7)} ${e.text} ${e.amount}`;
  });
  // Lo de este período (sin el saldo anterior ni su pago), en cada moneda
  const nf = new Intl.NumberFormat('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const total = (cur: 'local' | 'usd') => nf.format(STATEMENT.filter((e) => !/^(SALDO|SU PAGO)/.test(e.text) && e.amount.startsWith('U$S') === (cur === 'usd'))
    .reduce((s, e) => s + (parseAmount(e.amount) ?? 0), 0));
  return [
    'OCA',
    'Estado de cuenta',
    'Titular: ANA PEREZ',
    `Período del ${dmy(`${prev}-26`)} al ${dmy(todayISO)}`,
    `Fecha de cierre: ${dmy(todayISO)}   Vencimiento: ${dmy(due)}`,
    'FECHA DESCRIPCION IMPORTE $ IMPORTE U$S',
    ...rows,
    `TOTAL A PAGAR ${total('local')} ${total('usd')}`,
    'Cotización del dólar: 40,10',
  ].join('\n');
}
