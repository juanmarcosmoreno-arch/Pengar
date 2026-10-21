import { splitUsdNote } from './fx';
import type { Index } from './stats';
import type { Data, SavingsBox } from './types';

/**
 * Lo que hay ahorrado ahora: el saldo escrito a mano (en pesos y en dólares) más lo que se anotó después en categorías
 * de ahorro, menos lo que se pasó del ahorro al mes (los ingresos del rubro «Del ahorro»). Lo anotado en dólares (con
 * la cuenta en la nota) va a los dólares.
 */
export function savingsBalance(data: Data, ix: Index, box: SavingsBox | undefined): { pesos: number; usd: number } {
  if (!box) return { pesos: 0, usd: 0 };
  let pesos = box.pesos;
  let usd = box.usd;
  for (const m of data.movements) {
    if (m.createdAt <= box.at) continue;
    const sign = m.kind === 'gasto' && ix.categoryOf(m)?.savings ? 1 : m.kind === 'ingreso' && box.rubroId && m.rubroId === box.rubroId ? -1 : 0;
    if (!sign) continue;
    const inUsd = splitUsdNote(m.note).usd;
    if (inUsd) usd += sign * inUsd;
    else pesos += sign * m.amount;
  }
  return { pesos: Math.round(pesos * 100) / 100, usd: Math.round(usd * 100) / 100 };
}

/** Los pases del ahorro al mes de `month` (YYYY-MM) */
export function transfersIn(data: Data, box: SavingsBox | undefined, month: string) {
  if (!box?.rubroId) return [];
  return data.movements.filter((m) => m.kind === 'ingreso' && m.rubroId === box.rubroId && m.date.startsWith(month));
}
