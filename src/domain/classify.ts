/**
 * Elegir el rubro de un renglón de factura: primero lo aprendido (lo que el usuario corrigió antes para ese
 * comercio o esa palabra), después las palabras clave de cada rubro y su nombre.
 */
import { norm } from './importSheet';
import { normalizeMerchant } from './statement';
import type { Rubro, Settings } from './types';

/**
 * Clave para aprender de un comercio («merchant:tienda inglesa»). Es la misma de los estados de cuenta, así lo
 * aprendido en una factura sirve para la tarjeta y al revés.
 */
export const merchantKey = (merchant: string) => `merchant:${normalizeMerchant(merchant).key}`;

/** La clave de antes (el nombre entero), para no perder lo aprendido con versiones anteriores */
const legacyMerchantKey = (merchant: string) => `merchant:${norm(merchant).replace(/\b(s\.?a\.?|srl|ltda)\b/g, '').trim()}`;

/** Clave para aprender de un renglón: sus dos primeras palabras significativas («item:leche conaprole») */
export function itemKey(description: string): string | null {
  const words = norm(description).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  return words.length ? `item:${words.slice(0, 2).join(' ')}` : null;
}

function keywordMatch(text: string, rubros: Rubro[]): { rubro: Rubro; length: number } | null {
  const t = ` ${norm(text)} `;
  let best: { rubro: Rubro; length: number } | null = null;
  for (const r of rubros) {
    if (r.archived) continue;
    for (const raw of [...r.keywords, r.name]) {
      const k = norm(raw);
      if (k.length < 3) continue;
      // Desde el comienzo de una palabra. Las claves con un espacio al final («pan ») y las de tres letras («ute», «gas»)
      // van enteras; las de cuatro, enteras o en plural («agua» no es «AGUACATE»); las largas, también como comienzo
      // («regalo» en «REGALOS»)
      const end = /\s$/.test(raw) || k.length <= 3 ? '(?=[^a-z0-9]|$)' : k.length === 4 ? '(?:e?s)?(?=[^a-z0-9]|$)' : '';
      const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${end}`);
      if (re.test(t) && (!best || k.length > best.length)) best = { rubro: r, length: k.length };
    }
  }
  return best;
}

export interface Suggestion {
  rubroId: string;
  /** De dónde salió: para mostrar «aprendido» o «por palabra clave» */
  reason: 'aprendido' | 'palabra' | 'comercio';
}

export function suggestRubro(
  description: string,
  merchant: string | undefined,
  rubros: Rubro[],
  learned: Settings['learned'],
): Suggestion | null {
  const valid = new Set(rubros.filter((r) => !r.archived).map((r) => r.id));
  const ik = itemKey(description);
  if (ik && valid.has(learned[ik])) return { rubroId: learned[ik], reason: 'aprendido' };
  const byItem = keywordMatch(description, rubros);
  if (byItem) return { rubroId: byItem.rubro.id, reason: 'palabra' };
  if (merchant) {
    for (const mk of [merchantKey(merchant), legacyMerchantKey(merchant)]) {
      if (valid.has(learned[mk])) return { rubroId: learned[mk], reason: 'aprendido' };
    }
    const byMerchant = keywordMatch(merchant, rubros);
    if (byMerchant) return { rubroId: byMerchant.rubro.id, reason: 'comercio' };
  }
  return null;
}

/** Lo que se aprende al guardar una factura revisada (de los descuentos, nada: «DCTO SOCIO» no dice de qué rubro es) */
export function learnFrom(
  learned: Settings['learned'],
  merchant: string | undefined,
  items: { description: string; amount?: number; rubroId?: string }[],
): Settings['learned'] {
  const next = { ...learned };
  const counts = new Map<string, number>();
  for (const it of items) {
    if (!it.rubroId || (it.amount ?? 0) < 0) continue;
    const k = itemKey(it.description);
    if (k) next[k] = it.rubroId;
    counts.set(it.rubroId, (counts.get(it.rubroId) ?? 0) + 1);
  }
  // El comercio se asocia al rubro más frecuente de la factura
  if (merchant?.trim() && counts.size) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    next[merchantKey(merchant)] = top;
  }
  return next;
}
