/** Datos de ejemplo (inventados): para mirar la app sin cargar nada y para la vista previa web. */
import { addMonths, monthOf } from './dates';
import { parseAmount, round2 } from './money';
import { norm, type ImportResult } from './importSheet';
import { normalizeMerchant } from './statement';
import { defaultSettings, newId, normalizeData } from './template';
import type { Data, Invoice, InvoiceInstallment, Kind, Movement, Rubro } from './types';

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

interface CardExample {
  card: string;
  /** El cierre: hace `back` meses, el día `day` */
  back: number;
  day: number;
  limit?: number;
  available?: number;
  /** Como lo escribe el banco; `n` de `of` es la cuota de ese estado de cuenta */
  cuotas: { text: string; amount: number; n: number; of: number; usd?: number }[];
}

/**
 * Los estados de cuenta anteriores de tres tarjetas, con compras en cuotas (todo inventado): para que «Tarjetas y
 * cuotas» tenga qué mostrar. Las de OCA siguen en el estado de cuenta de ejemplo (STATEMENT: Farmashop 2/3, la
 * mueblería 3/10 y la bicicletería 2/6, pegada como en Scotiabank). El de Scotiabank es de hace dos meses: falta el
 * último (la pantalla lo pide). No tienen gastos: esos meses ya están en la planilla
 */
const CARDS: CardExample[] = [
  {
    card: 'OCA', back: 1, day: 25, limit: 120000, available: 83400,
    cuotas: [
      { text: 'FARMASHOP 14', amount: 1500, n: 1, of: 3 },
      { text: 'MUEBLERIA LOS ALAMOS', amount: 3200, n: 2, of: 10 },
      { text: 'BICICLETERIA LA RUEDA', amount: 2150, n: 1, of: 6 },
    ],
  },
  {
    card: 'Itaú', back: 1, day: 28, limit: 180000, available: 131200,
    cuotas: [
      { text: 'COLCHONERIA EL DESCANSO', amount: 2450, n: 5, of: 12 },
      { text: 'OPTICA DEL SUR', amount: 1180, n: 2, of: 6 },
      { text: 'VUELOS CELESTE', amount: 4010, n: 3, of: 6, usd: 100 },
      { text: 'ZAPATERIA EL PASO', amount: 990, n: 3, of: 3 },
    ],
  },
  {
    card: 'Scotiabank', back: 2, day: 15, limit: 90000, available: 64800,
    cuotas: [
      { text: 'LIBRERIA DEL PUERTO', amount: 640, n: 1, of: 3 },
      { text: 'VIVERO EL CEIBO', amount: 1200, n: 4, of: 12 },
    ],
  },
];

/** La cotización con que se pasaron a pesos las cuotas en dólares del ejemplo */
const CARD_RATE = 40.1;

/** Los estados de cuenta de ejemplo de cada tarjeta (sin archivo: se ven como la lista de lo que traen) */
export function exampleStatements(todayISO: string): Invoice[] {
  const month = monthOf(todayISO);
  return CARDS.map((c, k) => {
    const closingMonth = addMonths(month, -c.back);
    const date = `${closingMonth}-${String(c.day).padStart(2, '0')}`;
    const installments: InvoiceInstallment[] = c.cuotas.map((q) => ({
      ...normalizeMerchant(q.text),
      amount: q.amount,
      n: q.n,
      of: q.of,
      // La compra: el mes de la primera cuota, el día 10
      date: `${addMonths(closingMonth, 1 - q.n)}-10`,
      ...(q.usd ? { usd: q.usd, rate: CARD_RATE } : {}),
    }));
    return {
      id: newId('f'),
      kind: 'estado',
      card: c.card,
      fileName: `estado-de-cuenta-${norm(c.card)}.txt`,
      mime: 'text/plain',
      date,
      total: round2(installments.reduce((s, i) => s + i.amount, 0)),
      items: installments.map((i) => ({ description: `${i.merchant} · cuota ${i.n}/${i.of}`, amount: i.amount, date })),
      installments,
      ...(c.limit ? { limit: c.limit } : {}),
      ...(c.available ? { available: c.available } : {}),
      // Subidos en el orden de la lista (el color de cada tarjeta en las gráficas)
      createdAt: new Date(`${date}T20:00:00`).getTime() + k,
    };
  });
}

/** Todo el ejemplo: la planilla importada (hasta el mes pasado), lo anotado este mes, los estados de cuenta, una meta y «Ana» */
export function exampleData(res: Pick<ImportResult, 'categories' | 'rubros' | 'movements'>, todayISO: string): Data {
  return normalizeData({
    categories: res.categories,
    rubros: res.rubros,
    movements: [...alignMonths(res.movements, addMonths(monthOf(todayISO), -1)), ...exampleDaily(res.rubros, todayISO)],
    invoices: exampleStatements(todayISO),
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
  /** Día del mes: en un mes anterior tal cual; en este mes, acomodado hasta hoy (como DAILY) */
  day: number;
  /** Meses antes del actual (las cuotas de compras de antes vienen con la fecha de la compra) */
  back?: number;
  text: string;
  /** Como viene en el estado de cuenta («-» para pagos y créditos, «U$S» para dólares) */
  amount: string;
}

/**
 * Compras del estado de cuenta de ejemplo. Algunos comercios coinciden con las palabras de los rubros del ejemplo
 * (Tienda Inglesa, Farmashop, Netflix…) y otros son nuevos; Tienda Inglesa del 4 y Farmashop del 17 ya están
 * anotados en DAILY (posibles repetidos). Las cuotas siguen las del estado de cuenta anterior de OCA (CARDS): la de
 * la mueblería y la de la bicicletería (pegada al comercio, como en Scotiabank) vienen con la fecha de la compra.
 */
const STATEMENT: StatementExample[] = [
  { back: 2, day: 10, text: 'MUEBLERIA LOS ALAMOS CUOTA 03/10', amount: '3.200,00' },
  { back: 1, day: 10, text: 'BICICLETERIA LA RUEDAC02/06', amount: '2.150,00' },
  { back: 1, day: 26, text: 'SALDO ANTERIOR', amount: '21.540,00' },
  { back: 1, day: 27, text: 'TIENDA INGLESA SUC 12 MONTEVIDEO', amount: '2.418,30' },
  { back: 1, day: 28, text: 'MERCADOPAGO*LA PASIVA', amount: '890,00' },
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
  { day: 22, text: 'JUGUETERIA EL TREN C01/03', amount: '1.340,00' },
  { day: 24, text: 'PANADERIA LA ESPIGA', amount: '420,00' },
];

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Estado de cuenta de ejemplo (OCA, en texto como lo lee el PDF), del 26 del mes pasado a hoy: para probar «Tarjeta»
 * con los datos de ejemplo. Trae compras conocidas y nuevas, un pago, el reintegro de IVA, compras en dólares y
 * cuotas (una nueva y tres que siguen, dos con la fecha de la compra).
 */
export function exampleStatementText(todayISO: string): string {
  const month = monthOf(todayISO);
  const prev = addMonths(month, -1);
  const todayDay = Number(todayISO.slice(8, 10));
  const due = new Date(Date.UTC(+todayISO.slice(0, 4), +todayISO.slice(5, 7) - 1, todayDay + 15)).toISOString().slice(0, 10);
  const rows = STATEMENT.map((e) => {
    const day = e.back ? e.day : Math.max(1, Math.ceil((e.day / 28) * todayDay));
    const date = `${addMonths(month, -(e.back ?? 0))}-${String(day).padStart(2, '0')}`;
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
