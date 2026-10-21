/** Textos de la interfaz que dependen de una cantidad o de una lista */

/** «1 rubro», «3 rubros» */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «uno», «uno y dos», «uno, dos y tres» */
export const joinAnd = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} y ${list.at(-1)}` : list[0] ?? '');

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
