/** Cuándo volver a pedir Face ID: al abrir siempre y, al volver a la app, según cuánto estuvo en segundo plano. */

/** Segundos en segundo plano antes de volver a pedirlo: al instante, 1 minuto o 5 minutos */
export type LockAfter = 0 | 60 | 300;
export const LOCK_AFTER: LockAfter[] = [0, 60, 300];

/**
 * ¿Hay que bloquear al volver? `lastBackground`: cuándo salió de la app (ms). Sin ese dato, o si el reloj del
 * teléfono quedó antes (lo cambiaron), se bloquea: mejor pedirlo de más que de menos.
 */
export function shouldLock(lastBackground: number | null | undefined, now: number, after: LockAfter): boolean {
  if (lastBackground == null || !Number.isFinite(lastBackground)) return true;
  const away = now - lastBackground;
  return away < 0 || away >= after * 1000;
}

/**
 * Lo que avisa el iPhone: `inactive` (deja de estar al frente: el selector de apps, el centro de control, el
 * cartel de Face ID), `background` (pasó por segundo plano: otra app o la pantalla de inicio; se avisa al salir y al
 * volver) y `active` (volvió al frente).
 */
export type AppEvent = 'inactive' | 'background' | 'active';

/** Desde cuándo está afuera y si llegó a pasar a segundo plano */
export interface Away {
  since: number | null;
  background: boolean;
}
export const HERE: Away = { since: null, background: false };

/**
 * Sigue las salidas de la app y dice si, al volver, hay que bloquear. Solo cuenta si pasó a segundo plano: el cartel
 * de Face ID también la deja inactiva un momento, y si eso bloqueara, desbloquear volvería a bloquear.
 */
export function trackAway(away: Away, event: AppEvent, now: number, after: LockAfter): { away: Away; lock: boolean } {
  if (event === 'inactive') return { away: { since: now, background: false }, lock: false };
  if (event === 'background') return { away: { since: away.since ?? now, background: true }, lock: false };
  return { away: HERE, lock: away.background && shouldLock(away.since, now, after) };
}
