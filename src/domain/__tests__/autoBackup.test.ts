import { describe, expect, it } from 'vitest';
import {
  RETRY_AFTER, backupDate, backupDue, backupName, backupWhen, backupsToRemove, dataHash, normalizeAutoBackup,
  type AutoBackupState,
} from '../autoBackup';
import { addDays } from '../dates';
import { emptyData } from '../template';
import { fileSize } from '../text';
import type { Data } from '../types';

/** En hora local, como la del teléfono: `at(21)` es el 21/10/2026 a las 9:12 */
const at = (day: number, h = 9, min = 12, month = 10) => new Date(2026, month - 1, day, h, min).getTime();

const mine = (): Data => ({ ...emptyData(), settings: { ...emptyData().settings, name: 'Juan', onboarded: true } });
const withMovement = (d: Data, amount: number): Data => ({
  ...d,
  movements: [...d.movements, { id: `m${amount}`, date: '2026-10-21', amount, kind: 'gasto', rubroId: 'r1', origin: 'manual', createdAt: 1 }],
});
const on: AutoBackupState = { enabled: true };

describe('nombre de los respaldos', () => {
  it('uno por día: «pengar-AAAA-MM-DD.json»', () => {
    expect(backupName('2026-10-21')).toBe('pengar-2026-10-21.json');
    expect(backupDate('pengar-2026-10-21.json')).toBe('2026-10-21');
  });
  it('los demás archivos de la carpeta no son automáticos', () => {
    for (const name of ['pengar-respaldo-2026-10-21.json', 'pengar-2026-10-21.json.icloud', 'notas.txt', 'pengar-2026-10-21 (1).json', 'Pengar-2026-10-21.json']) {
      expect(backupDate(name)).toBeNull();
    }
  });
});

describe('hash de los datos', () => {
  it('los mismos datos dan lo mismo; cualquier cambio, otro', () => {
    const d = mine();
    expect(dataHash(d)).toBe(dataHash(structuredClone(d)));
    expect(dataHash(withMovement(d, 100))).not.toBe(dataHash(d));
    expect(dataHash(withMovement(d, 100))).not.toBe(dataHash(withMovement(d, 101)));
    expect(dataHash({ ...d, settings: { ...d.settings, name: 'Ana' } })).not.toBe(dataHash(d));
  });
  it('la clave de Claude no cuenta: no va en el respaldo', () => {
    const d = mine();
    expect(dataHash({ ...d, settings: { ...d.settings, ai: { ...d.settings.ai, apiKey: 'sk-ant-xyz' } } })).toBe(dataHash(d));
  });
});

describe('cuándo hacer un respaldo', () => {
  const d = mine();
  const hash = dataHash(d);

  it('el primero: enseguida', () => {
    expect(backupDue(on, d, at(21))).toEqual({ due: true, hash });
  });
  it('uno por día: ya hay uno de hoy, aunque haya cambios', () => {
    expect(backupDue({ ...on, last: at(21, 0, 5), lastHash: 'otro' }, d, at(21, 23, 59))).toEqual({ due: false, why: 'today' });
  });
  it('otro día: solo si cambiaron los datos', () => {
    expect(backupDue({ ...on, last: at(20), lastHash: hash }, d, at(21))).toEqual({ due: false, why: 'same' });
    const changed = withMovement(d, 250);
    expect(backupDue({ ...on, last: at(20), lastHash: hash }, changed, at(21))).toEqual({ due: true, hash: dataHash(changed) });
    // Un mes sin abrir la app, y nada cambió: no hace falta
    expect(backupDue({ ...on, last: at(20, 9, 12, 9), lastHash: hash }, d, at(21))).toEqual({ due: false, why: 'same' });
  });
  it('por día de calendario, no por 24 h: el de ayer a la noche y hoy de mañana', () => {
    const changed = withMovement(d, 1);
    expect(backupDue({ ...on, last: at(20, 23, 59), lastHash: hash }, changed, at(21, 0, 1)).due).toBe(true);
    // Quien abre la app todos los días a la misma hora (un poco antes que ayer) no se saltea días
    expect(backupDue({ ...on, last: at(20, 20, 5), lastHash: hash }, changed, at(21, 19, 55)).due).toBe(true);
  });
  it('con el reloj atrasado (el último quedó «en el futuro»), otro día: toca', () => {
    expect(backupDue({ ...on, last: at(25), lastHash: 'otro' }, d, at(21)).due).toBe(true);
  });
  it('apagado: no', () => {
    expect(backupDue({ enabled: false }, d, at(21))).toEqual({ due: false, why: 'off' });
  });
  it('los datos de ejemplo y la app sin datos: nunca, ni con «Hacer un respaldo ahora»', () => {
    const example: Data = { ...d, settings: { ...d.settings, example: true } };
    expect(backupDue(on, example, at(21))).toEqual({ due: false, why: 'example' });
    expect(backupDue(on, example, at(21), true)).toEqual({ due: false, why: 'example' });
    // La bienvenida (también después de «Borrar todo»): no pisa el de hoy con datos vacíos
    expect(backupDue(on, emptyData(), at(21))).toEqual({ due: false, why: 'empty' });
    expect(backupDue(on, emptyData(), at(21), true)).toEqual({ due: false, why: 'empty' });
  });
  it('después de un error espera una hora para probar solo', () => {
    const failed = { ...on, last: at(20), lastHash: 'otro', failed: { at: at(21, 9, 0), message: 'sin lugar' } };
    expect(backupDue(failed, d, at(21, 9, 30))).toEqual({ due: false, why: 'wait' });
    expect(backupDue(failed, d, at(21, 9, 0) + RETRY_AFTER).due).toBe(true);
    // Un error «del futuro» (el reloj se atrasó) no frena
    expect(backupDue({ ...failed, failed: { at: at(22), message: 'x' } }, d, at(21)).due).toBe(true);
  });
  it('«Hacer un respaldo ahora»: aunque ya haya uno de hoy, nada haya cambiado, esté apagado o recién haya fallado', () => {
    const state = { enabled: false, last: at(21, 8), lastHash: hash, failed: { at: at(21, 9), message: 'x' } };
    expect(backupDue(state, d, at(21, 9, 5), true)).toEqual({ due: true, hash });
  });
});

describe('una semana de uso', () => {
  /** Cada evento: [día, hora, cambió algo antes]. Como lo hace la app: si sale bien, guarda cuándo y el hash */
  function run(events: [number, number, boolean][], fail: number[] = []): string[] {
    let state: AutoBackupState = { enabled: true };
    let data = mine();
    const done: string[] = [];
    events.forEach(([day, hour, change], i) => {
      if (change) data = withMovement(data, i + 1);
      const now = at(day, hour, 0);
      const decision = backupDue(state, data, now);
      if (!decision.due) return;
      if (fail.includes(i)) state = { ...state, failed: { at: now, message: 'sin lugar' } };
      else {
        state = { ...state, last: now, lastHash: decision.hash, failed: undefined };
        done.push(`${day} ${hour}h`);
      }
    });
    return done;
  }
  it('al abrir y al salir: a lo sumo uno por día, y solo con cambios', () => {
    const events: [number, number, boolean][] = [
      [19, 9, false], // lunes al abrir: el primero
      [19, 21, true], // anotó algo y salió: ya hay uno de hoy
      [20, 9, false], // martes al abrir: con lo del lunes a la noche
      [20, 21, false],
      [21, 9, false], // miércoles al abrir: nada cambió desde el de ayer
      [21, 21, true], // anotó algo y salió
      [22, 9, false], // jueves: nada nuevo
    ];
    expect(run(events)).toEqual(['19 9h', '20 9h', '21 21h']);
  });
  it('si falla, vuelve a probar pasada una hora (el mismo día)', () => {
    const events: [number, number, boolean][] = [[21, 9, true], [21, 9, false], [21, 10, false], [21, 11, false]];
    expect(run(events, [0])).toEqual(['21 10h']);
  });
});

describe('cuáles se conservan', () => {
  /** Un respaldo por día desde `from`, `n` días */
  const daily = (from: string, n: number) => Array.from({ length: n }, (_, i) => backupName(addDays(from, i)));
  const kept = (names: string[]) => {
    const gone = new Set(backupsToRemove(names));
    return names.filter((n) => !gone.has(n)).map((n) => backupDate(n) ?? n).sort();
  };

  it('con 14 o menos, todos', () => {
    expect(backupsToRemove(daily('2026-10-08', 14))).toEqual([]);
    expect(backupsToRemove([])).toEqual([]);
  });
  it('los 14 más nuevos y el último de cada mes anterior', () => {
    // Del 12/9 al 21/10: quedan del 8/10 al 21/10 y el del 30/9
    expect(kept(daily('2026-09-12', 40))).toEqual(['2026-09-30', ...daily('2026-10-08', 14).map((n) => backupDate(n))]);
  });
  it('uno por mes de los últimos 12 meses (con respaldos), contando este', () => {
    // Todos los días desde el 1/1/2025: 659 respaldos
    const names = daily('2025-01-01', 659);
    expect(names.at(-1)).toBe('pengar-2026-10-21.json');
    const out = kept(names);
    expect(out).toHaveLength(14 + 11);
    expect(out.slice(0, 11)).toEqual([
      '2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
      '2026-05-31', '2026-06-30', '2026-07-31', '2026-08-31', '2026-09-30',
    ]);
    expect(out.slice(11)).toEqual(daily('2026-10-08', 14).map((n) => backupDate(n)));
  });
  it('por cantidad, no por fecha: después de meses sin abrir la app no se borra lo de antes', () => {
    const names = [...daily('2026-03-01', 10), 'pengar-2026-10-21.json'];
    expect(backupsToRemove(names)).toEqual([]);
  });
  it('con pocos por mes: los 14 más nuevos cubren varios meses', () => {
    // El 1 de cada mes, durante 20 meses: quedan los 14 más nuevos (que ya son uno por mes)
    const names = Array.from({ length: 20 }, (_, i) => backupName(`${2025 + Math.floor((i + 2) / 12)}-${String(((i + 2) % 12) + 1).padStart(2, '0')}-01`));
    expect(names[0]).toBe('pengar-2025-03-01.json');
    expect(names.at(-1)).toBe('pengar-2026-10-01.json');
    expect(backupsToRemove(names)).toEqual(names.slice(0, 6).reverse());
  });
  it('los demás archivos de la carpeta no se tocan', () => {
    const others = ['pengar-respaldo-2026-01-05.json', 'notas.txt', 'copia.json'];
    expect(backupsToRemove([...others, ...daily('2026-01-01', 200)]).some((n) => others.includes(n))).toBe(false);
  });
});

describe('lo guardado', () => {
  it('lo que no sirve se descarta', () => {
    expect(normalizeAutoBackup(null, true)).toEqual({ enabled: true });
    expect(normalizeAutoBackup({ enabled: false, last: 5, lastHash: 'h' }, true)).toEqual({ enabled: false, last: 5, lastHash: 'h' });
    expect(normalizeAutoBackup({ last: Infinity, failed: { at: 1, message: 2 } }, false)).toEqual({ enabled: false });
  });
});

describe('cuándo fue el último', () => {
  const now = at(21, 15, 0);
  it('hoy, ayer o el día', () => {
    expect(backupWhen(at(21, 9, 12), now)).toBe('hoy 9:12');
    expect(backupWhen(at(20, 21, 5), now)).toBe('ayer 21:05');
    expect(backupWhen(at(18, 0, 0), now)).toBe('el 18/10 0:00');
    expect(backupWhen(at(30, 8, 0, 9), now)).toBe('el 30/9 8:00');
    expect(backupWhen(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe('el 31/12/2025 23:59');
  });
  it('ayer, aunque hoy sea el 1 del mes', () => {
    expect(backupWhen(at(30, 22, 0, 9), at(1, 8, 0, 10))).toBe('ayer 22:00');
  });
  it('el tamaño, para la lista', () => {
    expect(fileSize(300)).toBe('1 KB');
    expect(fileSize(850 * 1024)).toBe('850 KB');
    expect(fileSize(1.25 * 1024 * 1024)).toBe('1,3 MB');
    expect(fileSize(12.4 * 1024 * 1024)).toBe('12 MB');
  });
});

describe('archivos de las facturas guardados aparte', () => {
  it('se borran los que ya no usa ningún respaldo que queda', async () => {
    const { archivesToRemove, archiveId, archiveName } = await import('../autoBackup');
    expect(archiveId(archiveName('f1'))).toBe('f1');
    expect(archiveId('pengar-2026-10-21.json')).toBeNull();
    const kept = ['pengar-2026-10-21.json', 'pengar-2026-09-30.json', 'mio.json'];
    expect(archivesToRemove({ f1: '2026-10-21', f2: '2026-09-30', f3: '2026-09-29' }, kept)).toEqual(['f3']);
    expect(archivesToRemove({ f1: '2026-01-01' }, ['mio.json'])).toEqual([]);
  });
});
