/**
 * Revisar un estado de cuenta: las compras se agrupan por comercio y cada comercio se aprende una sola vez
 * (settings.learned, con la misma clave que las facturas). Los que no son gastos (transferencias, débitos que no
 * interesan) se recuerdan con NOT_SPEND.
 */
import { merchantKey, suggestRubro, type Suggestion } from './classify';
import { formatRate, rateOn, usd, type UsdRate } from './fx';
import { latestCuotas } from './installments';
import { round2 } from './money';
import { isSpend, toLocal, withoutInstallment, type StatementTx } from './statement';
import type { Category, InvoiceInstallment, Rubro, Settings } from './types';

/** Valor de settings.learned para un comercio que no es un gasto: la próxima vez va directo a «No son gastos» */
export const NOT_SPEND = '__no_gasto';

export interface MerchantGroup {
  key: string;
  /** Nombre para mostrar (el de la primera compra) */
  merchant: string;
  /** Descripción de la primera compra (para aprender y para las palabras clave) */
  description: string;
  /** Índices de las compras en el estado de cuenta */
  idx: number[];
}

/** Compras y cargos agrupados por comercio, en el orden en que aparecen. `skip`: los que van aparte (repetidos) */
export function groupSpends(txs: StatementTx[], skip: (i: number) => boolean = () => false): MerchantGroup[] {
  const groups = new Map<string, MerchantGroup>();
  txs.forEach((tx, i) => {
    if (!isSpend(tx) || skip(i)) return;
    const g = groups.get(tx.key);
    if (g) g.idx.push(i);
    else groups.set(tx.key, { key: tx.key, merchant: tx.merchant, description: tx.description, idx: [i] });
  });
  return [...groups.values()];
}

/** Clave de settings.learned de un comercio del estado de cuenta («merchant:tienda inglesa») */
export const learnedKeyOf = (tx: Pick<StatementTx, 'description'>) => merchantKey(tx.description);

/** Rubros de gasto (los de ingreso no se ofrecen para la tarjeta) */
export function spendRubros(rubros: Rubro[], categories: Category[]): Rubro[] {
  const spend = new Set(categories.filter((c) => c.kind === 'gasto').map((c) => c.id));
  return rubros.filter((r) => !r.archived && spend.has(r.categoryId));
}

/**
 * Lo que ya se sabe de un comercio: primero lo aprendido para ese comercio (un rubro o «no es un gasto»), después
 * las palabras clave de los rubros. `rubros`: los de gasto.
 */
export function knownRubro(tx: StatementTx, rubros: Rubro[], learned: Settings['learned']): Suggestion | typeof NOT_SPEND | null {
  const value = learned[learnedKeyOf(tx)];
  if (value === NOT_SPEND) return NOT_SPEND;
  if (value && rubros.some((r) => r.id === value)) return { rubroId: value, reason: 'aprendido' };
  // Sin el texto de la cuota: «CUOTA 02/03» no dice de qué es la compra
  return suggestRubro(withoutInstallment(tx.description), tx.merchant, rubros, learned);
}

const dayNumber = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400_000;

export interface CreditTarget {
  key: string;
  date: string;
}

/**
 * De qué compras sale un crédito, en orden: las del mismo comercio (una devolución) o, si no hay, todas; primero la
 * más cercana del mismo día o de antes (el reintegro de IVA viene después de la compra), después las de más adelante.
 */
export function creditTargets(items: CreditTarget[], credit: CreditTarget): number[] {
  const all = items.map((_, j) => j);
  const same = all.filter((j) => items[j].key === credit.key);
  const day = dayNumber(credit.date);
  const rank = (j: number) => {
    const d = day - dayNumber(items[j].date);
    return d >= 0 ? d : 10_000 - d;
  };
  return (same.length ? same : all).sort((a, b) => rank(a) - rank(b) || b - a);
}

/**
 * Créditos que se restan de lo que se guarda (devoluciones, reintegro de IVA): cada uno sale de la compra que le
 * corresponde (creditTargets) y, si la supera, de las siguientes; ninguna queda en negativo. Devuelve los montos
 * nuevos, en el mismo orden.
 */
export function applyCredits(amounts: number[], items: CreditTarget[], credits: (CreditTarget & { amount: number })[]): number[] {
  const out = [...amounts];
  for (const credit of credits) {
    let left = round2(Math.abs(credit.amount));
    for (const j of creditTargets(items, credit)) {
      if (left <= 0) break;
      const cut = Math.min(out[j], left);
      out[j] = round2(out[j] - cut);
      left = round2(left - cut);
    }
  }
  return out;
}

export { usd };

/**
 * Nota del gasto: la tarjeta, la cuota (con la fecha de la compra, si la cuota va con la del cierre) y la cuenta en
 * dólares, siempre al final («OCA · cuota 2/3 · compra del 3/3/2026 · U$S 12,99 × 40,15»: ver splitUsdNote)
 */
export function statementNote(tx: StatementTx, card: string | undefined, usdRate: number): string | undefined {
  const parts = [
    card,
    tx.installment && `cuota ${tx.installment}`,
    tx.purchaseDate && `compra del ${dayMonthYear(tx.purchaseDate)}`,
    tx.currency === 'usd' && `${usd(tx.amount)} × ${formatRate(usdRate)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** «13/10» */
export const dayMonth = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

/** «3/3/2026» */
export const dayMonthYear = (iso: string) => `${dayMonth(iso)}/${iso.slice(0, 4)}`;

/**
 * Las compras en cuotas del estado de cuenta, para guardarlas con él (domain/installments proyecta las que siguen):
 * cada compra o cargo con cuota, en pesos con su cotización (`rates`, en el orden de `txs`), salvo los de
 * comercios que no son gastos (`skip`). Los repetidos y los de meses de la planilla sí van: igual se pagan. Una
 * planilla con varios meses trae la misma compra en cada mes (1/6, 2/6, 3/6): va la última (latestCuotas).
 */
export function statementInstallments(txs: StatementTx[], rates: number[], skip: (tx: StatementTx) => boolean = () => false): InvoiceInstallment[] {
  const out: InvoiceInstallment[] = [];
  txs.forEach((tx, i) => {
    const m = tx.installment?.match(/^(\d+)\/(\d+)$/);
    if (!m || !isSpend(tx) || skip(tx)) return;
    const rate = rates[i];
    // En dólares sin cotización no se sabe cuánto es en pesos
    if (tx.currency === 'usd' && !(rate > 0)) return;
    const usdPart = tx.currency === 'usd' ? { usd: tx.amount, rate } : {};
    out.push({ merchant: tx.merchant, key: tx.key, amount: toLocal(tx, rate), n: +m[1], of: +m[2], date: tx.purchaseDate ?? tx.date, ...usdPart });
  });
  return latestCuotas(out);
}

/** Lo que en dólares se pasa a pesos: las compras y los créditos (los pagos y el saldo, no) */
const usdToConvert = (t: StatementTx) => t.currency === 'usd' && (isSpend(t) || t.kind === 'credito');

/** De qué fechas hace falta la cotización del dólar (la primera y la última compra o crédito en U$S), o null */
export function usdDates(txs: StatementTx[]): { from: string; to: string } | null {
  const dates = txs.filter(usdToConvert).map((t) => t.date).sort();
  return dates.length ? { from: dates[0], to: dates.at(-1)! } : null;
}

/**
 * Cotización de cada movimiento (en el orden del estado de cuenta): si la persona escribió una, esa para todos; si
 * no, la del BCU de la fecha de cada compra (o la del último día hábil antes). null si a alguno le falta. Los en
 * pesos llevan 1 (toLocal no la usa).
 */
export function txRates(txs: StatementTx[], single: number | null, rates: UsdRate[] | null): number[] | null {
  const out: number[] = [];
  for (const t of txs) {
    if (!usdToConvert(t)) out.push(1);
    else if (single) out.push(single);
    else {
      const r = rates && rateOn(t.date, rates);
      if (!r) return null;
      out.push(r.rate);
    }
  }
  return out;
}
