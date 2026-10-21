/** Fechas como texto «YYYY-MM-DD» y meses como «YYYY-MM», siempre en hora local. */

export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];
export const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const today = () => toISODate(new Date());

/** «2026-10-21» + 3 → «2026-10-24» (en UTC: sin cambios de hora de por medio) */
export function addDays(date: string, n: number): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

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

/** El mes dentro de una frase: «setiembre», con el año si no es el de `now` («diciembre 2025») */
export function monthName(month: string, now = currentMonth()): string {
  return monthLabel(month, { year: month.slice(0, 4) !== now.slice(0, 4) }).toLowerCase();
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

/** Cuánto pasó desde `ms`: «hace un momento», «hace 5 min», «hace 2 h», «ayer» o «el 18/10» */
export function timeAgo(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  if (min < 24 * 60) return `hace ${Math.floor(min / 60)} h`;
  const d = new Date(ms);
  return dayLabel(toISODate(d), toISODate(new Date(now))) === 'Ayer' ? 'ayer' : `el ${d.getDate()}/${d.getMonth() + 1}`;
}

/** Desde qué día: «desde hoy», «desde ayer», «desde el lunes 12 de octubre» */
export function sinceDay(date: string, now = today()): string {
  const label = dayLabel(date, now);
  return label === 'Hoy' || label === 'Ayer' ? `desde ${label.toLowerCase()}` : `desde el ${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}
