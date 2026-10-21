/** Textos de la interfaz que dependen de una cantidad o de una lista */

/** «1 rubro», «3 rubros» */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «uno», «uno y dos», «uno, dos y tres» */
export const joinAnd = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list.at(-1)}` : list[0] ?? '');

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «850 KB», «1,2 MB», «12 MB» (de a 1024) */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} MB`;
}
