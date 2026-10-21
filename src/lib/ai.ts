/**
 * Lectura de facturas y sugerencia de rubros con Claude (opcional). Solo se usa si el usuario cargó su clave de la
 * API en Ajustes: la foto o el PDF (o los nombres de los comercios) van directo del teléfono a la API de Anthropic,
 * junto con la lista de rubros para elegir.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ParsedInvoice } from '../domain/invoice';
import type { Category, Rubro } from '../domain/types';
import { isPreview } from './platform';

export interface AiInvoice extends ParsedInvoice {
  items: { description: string; amount: number; rubro?: string }[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['merchant', 'date', 'total', 'items'],
  properties: {
    merchant: { type: 'string', description: 'Nombre del comercio o empresa que emite la factura' },
    date: { type: 'string', description: 'Fecha de emisión en formato YYYY-MM-DD, o vacío si no aparece' },
    total: { type: 'number', description: 'Total final pagado o a pagar, con impuestos' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'amount', 'rubro'],
        properties: {
          description: { type: 'string' },
          amount: { type: 'number', description: 'Importe del renglón (negativo si es un descuento)' },
          rubro: { type: 'string', description: 'Nombre exacto de uno de los rubros de la lista, o vacío si ninguno encaja' },
        },
      },
    },
  },
} as const;

export async function readInvoiceWithClaude(
  file: { base64: string; mime: string },
  opts: { apiKey: string; model: string; rubros: Rubro[]; categories: Category[] },
): Promise<AiInvoice> {
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
  const catName = new Map(opts.categories.map((c) => [c.id, c.name]));
  const list = opts.rubros.filter((r) => !r.archived).map((r) => `- ${r.name} (${catName.get(r.categoryId) ?? ''})`).join('\n');
  const doc: Anthropic.Beta.BetaContentBlockParam = file.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: file.base64 } };
  const response = await client.beta.messages.create({
    model: opts.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        doc,
        {
          type: 'text',
          text: `Esta es una factura o ticket de compra (probablemente de Uruguay, montos en pesos con coma decimal). `
            + `Extraé el comercio, la fecha, el total y cada renglón de producto o servicio con su importe final. `
            + `No incluyas como renglones los subtotales, el IVA, el total ni los datos del pago. `
            + `A cada renglón asignale el rubro que mejor le corresponda de esta lista (usá el nombre exacto):\n${list}`,
        },
      ],
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('Claude no pudo leer esta factura.');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = JSON.parse(text) as { merchant: string; date: string; total: number; items: { description: string; amount: number; rubro: string }[] };
  return {
    merchant: parsed.merchant || undefined,
    date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : undefined,
    total: parsed.total || undefined,
    items: parsed.items.filter((i) => i.amount).map((i) => ({ description: i.description, amount: i.amount, rubro: i.rubro || undefined })),
  };
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'option'],
        properties: {
          id: { type: 'string', description: 'El número del comercio o renglón, tal como viene en la lista' },
          option: { type: 'string', description: 'Nombre exacto de uno de los rubros, o vacío si no estás seguro' },
        },
      },
    },
  },
} as const;

/** Tandas grandes: es poco texto, pero la respuesta crece con cada ítem */
const CLASSIFY_BATCH = 100;

/**
 * Rubro más probable para comercios de la tarjeta o renglones de facturas (solo texto). Devuelve id → opción elegida
 * (quien llama la compara con la lista); los que no sabe no vienen. Nunca en la vista previa (no hay conexión con Anthropic).
 */
export async function classifyWithClaude(
  items: { id: string; text: string }[],
  options: string[],
  opts: { apiKey: string; model: string; hint?: string },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (isPreview || !opts.apiKey || !items.length || !options.length) return out;
  const client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
  for (let start = 0; start < items.length; start += CLASSIFY_BATCH) {
    const batch = items.slice(start, start + CLASSIFY_BATCH);
    const response = await client.beta.messages.create({
      model: opts.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: 'Sos un asistente de finanzas personales en Uruguay. Para cada comercio o renglón elegí el rubro más probable '
        + 'de la lista de opciones, con el nombre exacto, o dejalo vacío si no estás seguro. No inventes rubros.',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
      messages: [{
        role: 'user',
        content: `Son compras con tarjeta de crédito o renglones de facturas de Uruguay (comercios a veces abreviados).\n`
          + `Rubros posibles:\n${options.map((o) => `- ${o}`).join('\n')}\n`
          + (opts.hint ? `${opts.hint}\n` : '')
          + `\nComercios o renglones:\n${batch.map((it, i) => `${i + 1}. ${it.text}`).join('\n')}`,
      }],
    });
    if (response.stop_reason === 'refusal') throw new Error('Claude no pudo sugerir los rubros.');
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const parsed = JSON.parse(text) as { results: { id: string; option: string }[] };
    for (const r of parsed.results ?? []) {
      const item = batch[Number(r.id) - 1];
      if (item && r.option?.trim()) out.set(item.id, r.option);
    }
  }
  return out;
}
