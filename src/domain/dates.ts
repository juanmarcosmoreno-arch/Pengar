/** Fechas como texto «YYYY-MM-DD» y meses como «YYYY-MM», siempre en hora local. */

export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
export const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const today = () => toISODate(new Date());

export const monthOf = (date: string) => date.slice(0, 7);

export const currentMonth = () => monthOf(today());

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** Meses entre `from` y `to`, inclusive */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function monthLabel(month: string, opts: { year?: boolean; short?: boolean } = {}): string {
  const [y, m] = month.split('-').map(Number);
  const name = opts.short ? MONTHS_SHORT[m - 1] : MONTHS[m - 1];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return opts.year === false ? cap : `${cap} ${opts.short ? String(y).slice(2) : y}`;
}

/** «Hoy», «Ayer», «Lunes 12 de octubre» */
export function dayLabel(date: string, now = today()): string {
  if (date === now) return 'Hoy';
  const d = new Date(`${date}T12:00:00`);
  const y = new Date(`${now}T12:00:00`);
  y.setDate(y.getDate() - 1);
  if (date === toISODate(y)) return 'Ayer';
  const wd = d.toLocaleDateString('es-UY', { weekday: 'long' });
  const sameYear = date.slice(0, 4) === now.slice(0, 4);
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)} ${d.getDate()} de ${MONTHS[d.getMonth()]}${sameYear ? '' : ` de ${d.getFullYear()}`}`;
}

export function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1].toLowerCase()} ${y}`;
}
