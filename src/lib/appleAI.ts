/**
 * Apple Intelligence (plugin PengarAI, iOS 26+): sugiere rubros en el teléfono, sin conexión y sin costo.
 * En la web y en la vista previa no está.
 */
import { registerPlugin } from '@capacitor/core';
import { isNative, isPreview } from './platform';

/** `sdk`: la app se compiló sin el SDK de iOS 26 (Xcode 26), así que no lo trae aunque el teléfono lo tenga */
export type AppleAIStatus = 'available' | 'notEnabled' | 'notEligible' | 'notReady' | 'unsupported' | 'sdk';

interface PengarAIPlugin {
  availability(): Promise<{ appleIntelligence: AppleAIStatus }>;
  classify(options: { items: { id: string; text: string }[]; options: string[]; hint?: string }): Promise<{ results: { id: string; option: string }[] }>;
}

const PengarAI = registerPlugin<PengarAIPlugin>('PengarAI');

const STATUSES: AppleAIStatus[] = ['available', 'notEnabled', 'notEligible', 'notReady', 'unsupported', 'sdk'];
let cached: AppleAIStatus | null = null;

/**
 * Estado de Apple Intelligence en este teléfono. Se pregunta una vez; si no está activado o se está descargando,
 * se vuelve a preguntar (puede cambiar mientras la app está abierta).
 */
export async function appleAIStatus(): Promise<AppleAIStatus> {
  if (!isNative || isPreview) return 'unsupported';
  if (cached) return cached;
  let status: AppleAIStatus = 'unsupported';
  try {
    const res = await PengarAI.availability();
    if (STATUSES.includes(res.appleIntelligence)) status = res.appleIntelligence;
  } catch {
    // Sin el plugin (una app vieja): como si no hubiera
  }
  if (status !== 'notEnabled' && status !== 'notReady') cached = status;
  return status;
}

/** Rubro elegido para cada ítem (id → nombre de una de las opciones); los que no sabe no vienen */
export async function classifyWithApple(
  items: { id: string; text: string }[],
  options: string[],
  hint?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!items.length || !options.length) return out;
  const { results } = await PengarAI.classify({ items, options, hint });
  for (const r of results ?? []) if (r.option?.trim()) out.set(r.id, r.option);
  return out;
}
