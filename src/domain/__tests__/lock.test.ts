import { describe, expect, it } from 'vitest';
import { HERE, shouldLock, trackAway, type AppEvent, type Away, type LockAfter } from '../lock';

const T = Date.UTC(2026, 9, 21, 9, 0, 0);
const s = (n: number) => n * 1000;

describe('cuándo bloquear al volver', () => {
  it('al instante: siempre que salió', () => {
    expect(shouldLock(T, T, 0)).toBe(true);
    expect(shouldLock(T, T + 300, 0)).toBe(true);
  });
  it('con 1 o 5 minutos: recién pasado ese tiempo afuera', () => {
    expect(shouldLock(T, T + s(59), 60)).toBe(false);
    expect(shouldLock(T, T + s(60), 60)).toBe(true);
    expect(shouldLock(T, T + s(61), 60)).toBe(true);
    expect(shouldLock(T, T + s(120), 300)).toBe(false);
    expect(shouldLock(T, T + s(299.9), 300)).toBe(false);
    expect(shouldLock(T, T + s(300), 300)).toBe(true);
  });
  it('sin saber cuándo salió, o con el reloj atrasado, bloquea', () => {
    expect(shouldLock(null, T, 300)).toBe(true);
    expect(shouldLock(undefined, T, 60)).toBe(true);
    expect(shouldLock(Number.NaN, T, 60)).toBe(true);
    // Le cambiaron la hora al teléfono para atrás
    expect(shouldLock(T, T - s(3600), 300)).toBe(true);
  });
});

/** Una serie de avisos del iPhone ([evento, segundos desde T]); devuelve si bloqueó en cada vuelta */
function run(events: [AppEvent, number][], after: LockAfter): boolean[] {
  let away: Away = HERE;
  const locks: boolean[] = [];
  for (const [event, at] of events) {
    const res = trackAway(away, event, T + s(at), after);
    away = res.away;
    if (event === 'active') locks.push(res.lock);
  }
  return locks;
}

describe('salidas de la app', () => {
  it('el cartel de Face ID (o el centro de control) no cuenta: no pasó a segundo plano', () => {
    expect(run([['inactive', 0], ['active', 3]], 0)).toEqual([false]);
    expect(run([['inactive', 0], ['active', 400]], 300)).toEqual([false]);
  });
  it('a otra app y de vuelta: cuenta desde que dejó de estar al frente', () => {
    expect(run([['inactive', 0], ['background', 1], ['active', 30]], 0)).toEqual([true]);
    expect(run([['inactive', 0], ['background', 1], ['active', 30]], 60)).toEqual([false]);
    expect(run([['inactive', 0], ['background', 1], ['active', 60]], 60)).toEqual([true]);
    expect(run([['inactive', 0], ['background', 50], ['active', 70]], 60)).toEqual([true]);
  });
  it('cada vuelta empieza de cero', () => {
    const events: [AppEvent, number][] = [
      ['inactive', 0], ['background', 1], ['active', 90], // 90 s afuera: bloquea
      ['inactive', 100], ['active', 102], // Face ID al desbloquear: no
      ['inactive', 200], ['background', 201], ['active', 230], // 30 s: no
    ];
    expect(run(events, 60)).toEqual([true, false, false]);
  });
  it('al volver también avisa (resume): cuenta desde que salió, aunque el aviso de salida no haya llegado', () => {
    expect(run([['inactive', 0], ['background', 1], ['background', 85], ['active', 86]], 60)).toEqual([true]);
    expect(run([['inactive', 0], ['background', 85], ['active', 86]], 60)).toEqual([true]);
    expect(run([['inactive', 0], ['background', 1], ['background', 30], ['active', 31]], 60)).toEqual([false]);
  });
  it('si el aviso de segundo plano llega sin el de inactiva, cuenta desde ahí', () => {
    expect(run([['background', 0], ['active', 61]], 60)).toEqual([true]);
    expect(run([['background', 0], ['active', 59]], 60)).toEqual([false]);
  });
});
