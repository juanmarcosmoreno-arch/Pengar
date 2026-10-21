/**
 * Modo demo: datos inventados para mostrarle la app a otra persona sin que vea los tuyos. Van guardados aparte de los de
 * verdad (otra clave y otro prefijo para los archivos: lib/db) y el ajuste de este teléfono dice cuál se ve (lib/device).
 * Son los datos de ejemplo (sin diezmo ni ofrendas) más lo que hace lucir la app: gastos fijos para anotar, una factura
 * guardada (un ticket en PDF hecho acá) y los comercios del estado de cuenta de ejemplo ya aprendidos.
 */
import { learnFrom } from './classify';
import { addMonths, monthOf } from './dates';
import { exampleData } from './example';
import { norm, type ImportResult } from './importSheet';
import { recurringMovementId } from './recurring';
import { learnedKeyOf } from './statementReview';
import { newId, normalizeData } from './template';
import type { Data, Invoice, InvoiceItem, Kind, Movement, Recurring, Rubro, Settings } from './types';

/** Qué datos se ven: los de verdad o los del modo demo */
export type Dataset = 'real' | 'demo';

/** La clave de IndexedDB de los datos de cada juego */
export const dataKey = (set: Dataset) => (set === 'demo' ? 'data-demo' : 'data');

/** El prefijo de los archivos de facturas de cada juego: ninguno empieza con el del otro */
export const filePrefix = (set: Dataset) => (set === 'demo' ? 'demo-file:' : 'file:');

export const fileKey = (set: Dataset, id: string) => `${filePrefix(set)}${id}`;

/** El id de la factura de una clave de archivo de ese juego (null si es de otro juego o no es un archivo) */
export function fileIdOf(set: Dataset, key: string): string | null {
  const prefix = filePrefix(set);
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : null;
}

/** Un archivo de factura del demo (el ticket en PDF) */
export interface DemoFile {
  id: string;
  mime: string;
  bytes: Uint8Array;
}

/** El día de un mes de 28 acomodado para que el 28 caiga hoy (como lo anotado en el ejemplo) */
const scaled = (day28: number, todayDay: number) => Math.max(1, Math.ceil((day28 / 28) * todayDay));

interface DemoFixed {
  rubro: string;
  kind?: Kind;
  amount: number;
  note?: string;
  /** Ya anotado este mes (en lo de todos los días del ejemplo), con su día de siempre */
  done?: number;
  /** Para anotar: su día ya llegó (en un mes de 28, acomodado a hoy) */
  due?: number;
  /** Más adelante: tantos días después de hoy. Del 28 en adelante ya no queda día (los fijos llegan al 28): ya anotado */
  later?: number;
}

/** Gastos fijos: los ya anotados este mes, tres para anotar («Para anotar este mes») y tres más adelante */
const FIXED: DemoFixed[] = [
  { rubro: 'Entrada', kind: 'ingreso', amount: 186400, done: 1, note: 'Sueldo' },
  { rubro: 'Alquiler', amount: 24000, done: 2, note: 'Transferencia a la inmobiliaria' },
  { rubro: 'UTE', amount: 5200, done: 10 },
  { rubro: 'Antel', amount: 2600, due: 8 },
  { rubro: 'Netflix', amount: 500, due: 14 },
  { rubro: 'Emergencia móvil', amount: 4900, due: 22 },
  { rubro: 'OSE', amount: 760, later: 2 },
  { rubro: 'Club', amount: 3200, later: 4 },
  { rubro: 'Celular', amount: 1300, later: 6 },
];

/**
 * Comercios del estado de cuenta de ejemplo (domain/example, STATEMENT) que ya se conocen: al probar «Tarjeta» solo
 * quedan como nuevos Movie Center y la ferretería (la juguetería sale por las palabras de Regalos)
 */
const KNOWN_MERCHANTS: [string, string][] = [
  ['MUEBLERIA LOS ALAMOS', 'Arreglos casa'],
  ['BICICLETERIA LA RUEDA', 'Paseos'],
  ['TIENDA INGLESA 7', 'Supermercado'],
  ['MERCADOPAGO*LA PASIVA', 'Comer afuera'],
  ['NETFLIX.COM', 'Netflix'],
  ['PANADERIA LA ESPIGA', 'Supermercado'],
  ['DLO*UBER TRIP', 'Paseos'],
  ['ZARA 18 DE JULIO', 'Ropa'],
  ['FARMASHOP 3', 'Farmacia'],
  ['PEDIDOSYA*BURGER KING', 'Comer afuera'],
  ['SPOTIFY P2A4B6C8', 'Spotify'],
];

/** El ticket del súper (inventado): lo de comer va a Supermercado y lo de limpieza a Limpieza */
const TICKET: { description: string; amount: number; rubro: string }[] = [
  { description: 'Leche entera 1 L x4', amount: 196, rubro: 'Supermercado' },
  { description: 'Pan flauta x2', amount: 90, rubro: 'Supermercado' },
  { description: 'Yerba 1 kg', amount: 265, rubro: 'Supermercado' },
  { description: 'Queso dambo 300 g', amount: 318, rubro: 'Supermercado' },
  { description: 'Manzanas 1,5 kg', amount: 147, rubro: 'Supermercado' },
  { description: 'Detergente 750 ml', amount: 129, rubro: 'Limpieza' },
  { description: 'Lavandina 2 L', amount: 98, rubro: 'Limpieza' },
  { description: 'Papel higiénico x4', amount: 189, rubro: 'Limpieza' },
];
export const TICKET_MERCHANT = 'Súper El Trébol';

/** «1.432,00» */
export function ticketAmount(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

/** Un renglón del ticket: el texto a la izquierda y el monto a la derecha, en `width` letras */
const ticketRow = (left: string, right: string, width: number) => {
  const room = width - right.length - 1;
  return `${left.length > room ? left.slice(0, room) : left.padEnd(room)} ${right}`;
};

export interface TicketLine {
  text: string;
  bold?: boolean;
  center?: boolean;
  /** Tamaño de la letra en puntos (9 si no se dice) */
  size?: number;
}

/** Texto para un string de PDF: solo Latin-1 (lo demás, «?») y con \, ( y ) escapados */
const pdfString = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * Un PDF de una página con renglones de texto en Courier (como un ticket), sin nada externo: las letras son las
 * estándar del PDF, con los acentos de Windows-1252. `width` en puntos (216 ≈ 76 mm)
 */
export function ticketPdf(lines: TicketLine[], width = 216): Uint8Array {
  const margin = 16;
  const lead = 1.45;
  const height = Math.ceil(margin * 2 + lines.reduce((s, l) => s + (l.size ?? 9) * lead, 0));
  let y = height - margin;
  const ops = lines.map((l) => {
    const size = l.size ?? 9;
    y -= size * lead;
    // Courier: cada letra mide 0,6 del tamaño
    const x = l.center ? Math.max(margin, (width - l.text.length * size * 0.6) / 2) : margin;
    return `BT /${l.bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${(y + size * 0.35).toFixed(2)} Td (${pdfString(l.text)}) Tj ET`;
  }).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
    // Todo es de un byte por letra: el largo del texto es el de los bytes
    `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}

/** Los renglones del ticket de ejemplo, del día `date` */
export function demoTicketLines(date: string): TicketLine[] {
  const W = 30;
  const total = TICKET.reduce((s, t) => s + t.amount, 0);
  const rule = '-'.repeat(W);
  return [
    { text: TICKET_MERCHANT.toUpperCase(), bold: true, center: true, size: 12 },
    { text: 'Av. de los Ceibos 1234', center: true },
    { text: 'Ticket inventado (modo demo)', center: true },
    { text: '' },
    { text: ticketRow(`Fecha: ${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`, '10:42', W) },
    { text: rule },
    ...TICKET.map((t) => ({ text: ticketRow(t.description, ticketAmount(t.amount), W) })),
    { text: rule },
    { text: ticketRow('TOTAL', `$ ${ticketAmount(total)}`, W), bold: true },
    { text: rule },
    { text: '¡Gracias por su compra!', center: true },
  ];
}

/** Los datos del demo y los archivos de sus facturas (para guardarlos con el prefijo del demo) */
export interface DemoSet {
  data: Data;
  files: DemoFile[];
}

/**
 * Arma el demo: los datos de ejemplo (la planilla hasta el mes pasado, lo anotado este mes, la meta y «Ana») con
 * gastos fijos, una factura con su ticket en PDF y lo aprendido de los comercios. El resumen
 * del mes pasado queda sin abrir (la tarjeta de Inicio). No es el ejemplo de la bienvenida: lleva `settings.demo`
 */
function withoutTithe(d: Data): Data {
  const cats = new Set(d.categories.filter((c) => c.budget.type === 'percentIncome' || /diezmo|ofrenda/i.test(norm(c.name))).map((c) => c.id));
  const rubros = new Set(d.rubros.filter((r) => cats.has(r.categoryId) || /diezmo|ofrenda/i.test(norm(r.name))).map((r) => r.id));
  return {
    ...d,
    categories: d.categories.filter((c) => !cats.has(c.id)),
    rubros: d.rubros.filter((r) => !rubros.has(r.id)),
    movements: d.movements.filter((m) => !rubros.has(m.rubroId)),
    recurring: d.recurring.filter((r) => !rubros.has(r.rubroId)),
    settings: { ...d.settings, learned: Object.fromEntries(Object.entries(d.settings.learned).filter(([, v]) => !rubros.has(v))) },
  };
}

export function demoData(res: Pick<ImportResult, 'categories' | 'rubros' | 'movements'>, todayISO: string): DemoSet {
  // Sin diezmo ni ofrendas: la demo es para mostrarle la app a cualquiera
  const base = withoutTithe(exampleData(res, todayISO));
  const month = monthOf(todayISO);
  const todayDay = Number(todayISO.slice(8, 10));
  const rubro = (name: string): Rubro | undefined => base.rubros.find((r) => !r.archived && norm(r.name) === norm(name));
  const day = (n: number) => `${month}-${String(Math.min(28, Math.max(1, n))).padStart(2, '0')}`;
  const createdAt = new Date(`${addMonths(month, -6)}-01T12:00:00`).getTime();
  const movements: Movement[] = [...base.movements];

  // Gastos fijos
  const recurring: Recurring[] = [];
  for (const f of FIXED) {
    const r = rubro(f.rubro);
    if (!r) continue;
    const at = f.done ?? (f.due != null ? scaled(f.due, todayDay) : Math.min(28, todayDay + (f.later ?? 0)));
    // Uno de más adelante cuyo día ya llegó (del 28 a fin de mes): no se pide, queda anotado como los de siempre
    const recorded = f.later != null && at <= todayDay;
    const id = newId('rec');
    recurring.push({
      id,
      rubroId: r.id,
      kind: f.kind ?? 'gasto',
      amount: f.amount,
      day: Math.min(28, Math.max(1, at)),
      note: f.note,
      doneThrough: f.done != null || recorded ? month : addMonths(month, -1),
      createdAt,
    });
    if (recorded) {
      const date = day(at);
      movements.push({ id: recurringMovementId(id, month), date, amount: f.amount, kind: f.kind ?? 'gasto', rubroId: r.id, note: f.note, origin: 'manual', createdAt: new Date(`${date}T09:00:00`).getTime() });
    }
  }

  // La factura del súper, separada por rubro, con su ticket en PDF (los estados de cuenta de las tarjetas ya vienen del ejemplo)
  let learned: Settings['learned'] = { ...base.settings.learned };
  const invoices: Invoice[] = [...base.invoices];
  const files: DemoFile[] = [];
  const items: InvoiceItem[] = TICKET.map((t) => ({ description: t.description, amount: t.amount, rubroId: rubro(t.rubro)?.id }));
  if (items.every((it) => it.rubroId)) {
    const id = newId('f');
    const date = day(scaled(16, todayDay));
    const at = new Date(`${date}T10:42:00`).getTime();
    const total = items.reduce((s, it) => s + it.amount, 0);
    invoices.push({ id, fileName: 'ticket-super-el-trebol.pdf', mime: 'application/pdf', merchant: TICKET_MERCHANT, date, total, items, createdAt: at });
    const byRubro = new Map<string, number>();
    for (const it of items) byRubro.set(it.rubroId!, (byRubro.get(it.rubroId!) ?? 0) + it.amount);
    for (const [rubroId, amount] of byRubro) {
      movements.push({ id: newId('m'), date, amount, kind: 'gasto', rubroId, merchant: TICKET_MERCHANT, invoiceId: id, origin: 'factura', createdAt: at });
    }
    learned = learnFrom(learned, TICKET_MERCHANT, items);
    files.push({ id, mime: 'application/pdf', bytes: ticketPdf(demoTicketLines(date)) });
  }

  // Lo aprendido de los comercios de la tarjeta
  for (const [description, name] of KNOWN_MERCHANTS) {
    const r = rubro(name);
    if (r) learned[learnedKeyOf({ description })] = r.id;
  }

  const data = normalizeData({
    ...base,
    datasetId: newId('d'),
    movements,
    invoices,
    recurring,
    goals: [...base.goals, { id: newId('g'), name: 'Fondo de emergencia', icon: 'piggy', target: 120000, saved: 74000 }],
    settings: { ...base.settings, example: undefined, demo: true, learned, lastReportSeen: undefined },
  });
  return { data, files };
}

/** Son datos armados por demoData: con la marca del demo, ya empezados y sin el ejemplo de la bienvenida */
export const isDemoData = (d: Pick<Data, 'settings'>): boolean =>
  d.settings.demo === true && d.settings.onboarded === true && !d.settings.example;

/**
 * El demo guardado hay que armarlo de nuevo (al entrar o al abrir): se armó otro mes (lo último anotado a mano es de un
 * mes que ya pasó: Inicio quedaría vacío y el resumen sería de otro mes) o no es del demo (un respaldo o una planilla
 * que se colaron: se verían cada vez que se muestra la app)
 */
export function demoOutdated(d: Pick<Data, 'movements' | 'settings'>, todayISO: string): boolean {
  if (!isDemoData(d)) return true;
  const daily = d.movements.filter((m) => !m.monthly);
  if (!daily.length) return true;
  return daily.reduce((m, x) => (monthOf(x.date) > m ? monthOf(x.date) : m), '') < monthOf(todayISO);
}
