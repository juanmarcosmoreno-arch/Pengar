/**
 * Lectura de facturas con Claude (opcional). Solo se usa si el usuario cargó su clave de la API en Ajustes:
 * la foto o el PDF van directo del teléfono a la API de Anthropic, junto con la lista de rubros para elegir.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ParsedInvoice } from '../domain/invoice';
import type { Category, Rubro } from '../domain/types';

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
