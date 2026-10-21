/**
 * Revisar un estado de cuenta: las compras se agrupan por comercio y cada comercio se aprende una sola vez
 * (settings.learned, con la misma clave que las facturas). Los que no son gastos (transferencias, débitos que no
 * interesan) se recuerdan con NOT_SPEND.
 */
import { merchantKey, suggestRubro, type Suggestion } from './classify';
import { round2 } from './money';
import { isSpend, type StatementTx } from './statement';
import type { Category, Rubro, Settings } from './types';

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
  return suggestRubro(tx.description, tx.merchant, rubros, learned);
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

const usdFormat = new Intl.NumberFormat('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateFormat = new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 });

/** «U$S 12,99» */
export const usd = (n: number) => `U$S ${usdFormat.format(n)}`;

/** Nota del gasto: la tarjeta, la cuota y la cuenta en dólares («OCA · cuota 2/3 · U$S 12,99 × 40») */
export function statementNote(tx: StatementTx, card: string | undefined, usdRate: number): string | undefined {
  const parts = [
    card,
    tx.installment && `cuota ${tx.installment}`,
    tx.currency === 'usd' && `${usd(tx.amount)} × ${rateFormat.format(usdRate)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** «13/10» */
export const dayMonth = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;
