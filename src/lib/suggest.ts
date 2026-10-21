/**
 * Rubro sugerido para comercios de la tarjeta y renglones de facturas. Primero lo aprendido y las palabras clave
 * (domain/classify); lo que queda sin rubro va a Apple Intelligence (en el teléfono, si está) y lo que siga sin
 * rubro, a Claude (si hay clave). Nunca tira: si la IA falla, devuelve lo que tenga.
 */
import { suggestRubro, type Suggestion } from '../domain/classify';
import { norm } from '../domain/importSheet';
import type { Data } from '../domain/types';
import { appleAIStatus, classifyWithApple } from './appleAI';
import { isPreview } from './platform';

export type SuggestReason = Suggestion['reason'] | 'apple' | 'claude';

export interface RubroSuggestion {
  rubroId: string;
  reason: SuggestReason;
}

export interface SuggestItem {
  id: string;
  /** Comercio de la tarjeta o descripción del renglón */
  text: string;
  /** Comercio de la factura (para lo aprendido y como contexto para la IA) */
  merchant?: string;
}

/** Comparación de nombres: sin mayúsculas, tildes, comillas ni punto final */
const key = (s: string) => norm(s).replace(/^["'«»“”\s]+|["'«»“”.\s]+$/g, '');

/**
 * Opciones para la IA: los rubros de gasto no archivados, con el nombre tal cual (si dos se llaman igual, con la
 * categoría entre paréntesis). La pista dice de qué categoría es cada uno.
 */
export function rubroOptions(data: Pick<Data, 'rubros' | 'categories'>): { options: string[]; rubroOf: (option: string) => string | undefined; hint: string } {
  const cats = new Map(data.categories.map((c) => [c.id, c]));
  const rubros = data.rubros
    .filter((r) => !r.archived && r.name.trim() && cats.get(r.categoryId)?.kind === 'gasto')
    .sort((a, b) => cats.get(a.categoryId)!.order - cats.get(b.categoryId)!.order);
  const repeated = new Map<string, number>();
  for (const r of rubros) repeated.set(key(r.name), (repeated.get(key(r.name)) ?? 0) + 1);
  const byKey = new Map<string, string>();
  const options: string[] = [];
  const groups = new Map<string, string[]>();
  for (const r of rubros) {
    const cat = cats.get(r.categoryId)!.name;
    const label = repeated.get(key(r.name))! > 1 ? `${r.name.trim()} (${cat})` : r.name.trim();
    if (byKey.has(key(label))) continue;
    byKey.set(key(label), r.id);
    options.push(label);
    groups.set(cat, [...(groups.get(cat) ?? []), label]);
  }
  const hint = `Categoría de cada rubro: ${[...groups].map(([cat, list]) => `${cat}: ${list.join(', ')}`).join('. ')}.`;
  // Si la respuesta trae la categoría entre paréntesis sin hacer falta, también vale
  const rubroOf = (option: string) => byKey.get(key(option)) ?? byKey.get(key(option.replace(/\s*\([^)]*\)\s*$/, '')));
  return { options, rubroOf, hint };
}

/** Lo que ve la IA: el texto, y el comercio de la factura si es otro */
function aiText(it: SuggestItem): string {
  const text = it.text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return it.merchant?.trim() && key(it.merchant) !== key(text) ? `${text} (en ${it.merchant.trim().slice(0, 40)})` : text;
}

export interface SuggestOptions {
  /** false: no preguntarle a Claude (por ejemplo, si la factura ya la leyó Claude) */
  claude?: boolean;
  onProgress?: (msg: string) => void;
}

export async function suggestRubros(items: SuggestItem[], data: Data, opts: SuggestOptions = {}): Promise<Map<string, RubroSuggestion>> {
  const out = new Map<string, RubroSuggestion>();
  try {
    await fill(out, items, data, opts);
  } catch (e) {
    console.warn('No se pudieron sugerir rubros', e);
  }
  return out;
}

/** Completa `out` de a poco, así lo que ya se encontró queda aunque algo falle después */
async function fill(out: Map<string, RubroSuggestion>, items: SuggestItem[], data: Data, opts: SuggestOptions): Promise<void> {
  const pending: SuggestItem[] = [];
  for (const it of items) {
    const s = suggestRubro(it.text, it.merchant, data.rubros, data.settings.learned);
    if (s) out.set(it.id, s);
    else if (it.text.trim()) pending.push(it);
  }
  if (!pending.length) return;
  const { options, rubroOf, hint } = rubroOptions(data);
  if (!options.length) return;

  // Una sola pregunta por texto (en la tarjeta el mismo comercio se repite)
  const byText = new Map<string, SuggestItem[]>();
  for (const it of pending) {
    const k = key(aiText(it));
    byText.set(k, [...(byText.get(k) ?? []), it]);
  }
  let ask = [...byText.values()].map((group, i) => ({ id: String(i + 1), text: aiText(group[0]), group }));
  const questions = () => ask.map(({ id, text }) => ({ id, text }));
  const apply = (answers: Map<string, string>, reason: SuggestReason) => {
    for (const q of ask) {
      const option = answers.get(q.id);
      const rubroId = option ? rubroOf(option) : undefined;
      if (rubroId) for (const it of q.group) out.set(it.id, { rubroId, reason });
    }
    ask = ask.filter((q) => !out.has(q.group[0].id));
  };

  try {
    if ((await appleAIStatus()) === 'available') {
      opts.onProgress?.('Eligiendo los rubros con Apple Intelligence…');
      apply(await classifyWithApple(questions(), options, hint), 'apple');
    }
  } catch (e) {
    console.warn('Apple Intelligence no pudo sugerir rubros', e);
  }

  const { apiKey, model } = data.settings.ai;
  // En la vista previa no (y el isPreview primero saca el SDK de esa build)
  if (!isPreview && ask.length && opts.claude !== false && apiKey) {
    try {
      opts.onProgress?.('Eligiendo los rubros con Claude…');
      const { classifyWithClaude } = await import('./ai');
      apply(await classifyWithClaude(questions(), options, { apiKey, model, hint }), 'claude');
    } catch (e) {
      console.warn('Claude no pudo sugerir rubros', e);
    }
  }
}
