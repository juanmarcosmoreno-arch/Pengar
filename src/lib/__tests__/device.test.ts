import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyData } from '../../domain/template';

// IndexedDB simulado en memoria (cada prueba carga lib/db y lib/device de cero)
const mocks = vi.hoisted(() => ({ kv: new Map<string, unknown>() }));
vi.mock('idb-keyval', () => ({
  createStore: () => 'pengar',
  get: async (k: string) => structuredClone(mocks.kv.get(k)),
  set: async (k: string, v: unknown) => void mocks.kv.set(k, structuredClone(v)),
  del: async (k: string) => void mocks.kv.delete(k),
  keys: async () => [...mocks.kv.keys()],
}));
vi.mock('../platform', () => ({ isNative: true, isPreview: false }));

async function fresh() {
  vi.resetModules();
  return { db: await import('../db'), device: await import('../device') };
}

beforeEach(() => mocks.kv.clear());

describe('ajustes de este teléfono', () => {
  it('de fábrica: sin bloqueo ni aviso, con el respaldo automático prendido (en el iPhone)', async () => {
    const { device } = await fresh();
    expect(await device.loadDevice()).toEqual({ lock: { enabled: false, after: 0 }, reportReminder: false, autoBackup: { enabled: true } });
  });
  it('lo guardado vuelve igual', async () => {
    const { device } = await fresh();
    const saved = {
      lock: { enabled: true, after: 300 as const },
      reportReminder: true,
      autoBackup: { enabled: false, last: 1_790_000_000_000, lastHash: 'abc', failed: { at: 1_790_000_100_000, message: 'sin lugar' } },
    };
    await device.saveDevice(saved);
    expect(mocks.kv.get('device')).toEqual(saved);
    expect(await device.loadDevice()).toEqual(saved);
  });
  it('lo que no sirve se descarta', async () => {
    const { device } = await fresh();
    const n = device.normalizeDevice;
    expect(n(null)).toEqual(device.defaultDevice());
    expect(n('sí')).toEqual(device.defaultDevice());
    const auto = { enabled: true };
    expect(n({ lock: { enabled: 'sí', after: 30 } })).toEqual({ lock: { enabled: false, after: 0 }, reportReminder: false, autoBackup: auto });
    expect(n({ lock: { enabled: true, after: 60 }, reportReminder: 1 })).toEqual({ lock: { enabled: true, after: 60 }, reportReminder: false, autoBackup: auto });
    expect(n({ lock: { enabled: true } })).toEqual({ lock: { enabled: true, after: 0 }, reportReminder: false, autoBackup: auto });
  });
  it('el respaldo automático: lo que no sirve se descarta y lo que falta queda de fábrica', async () => {
    const { device } = await fresh();
    const n = (autoBackup: unknown) => device.normalizeDevice({ autoBackup }).autoBackup;
    expect(n(undefined)).toEqual({ enabled: true });
    expect(n('sí')).toEqual({ enabled: true });
    expect(n({ enabled: false })).toEqual({ enabled: false });
    expect(n({ enabled: 'no', last: 'ayer', lastHash: 7, failed: { at: 'hoy', message: 'x' } })).toEqual({ enabled: true });
    expect(n({ enabled: true, last: Number.NaN, lastHash: '', failed: { at: 5 } })).toEqual({ enabled: true });
    expect(n({ enabled: true, last: 10, lastHash: 'h', failed: { at: 20, message: 'sin lugar' } })).toEqual({ enabled: true, last: 10, lastHash: 'h', failed: { at: 20, message: 'sin lugar' } });
  });
  it('en la web el respaldo automático viene apagado (no hay)', async () => {
    vi.doMock('../platform', () => ({ isNative: false, isPreview: false }));
    const { device } = await fresh();
    expect(device.defaultDevice().autoBackup).toEqual({ enabled: false });
    // De vuelta al iPhone para las demás (doUnmock sacaría también el de arriba)
    vi.doMock('../platform', () => ({ isNative: true, isPreview: false }));
  });
});

describe('migración: el aviso del día 1 pasa de los datos a este teléfono', () => {
  const withReminder = (on: unknown) => ({ ...emptyData(), settings: { ...emptyData().settings, onboarded: true, reportReminder: on } });

  it('prendido en los datos: queda prendido en el teléfono y sale de los datos', async () => {
    mocks.kv.set('data', withReminder(true));
    const { db, device } = await fresh();
    const data = await db.loadData();
    expect(data?.settings).not.toHaveProperty('reportReminder');
    expect(await device.loadDevice()).toEqual({ lock: { enabled: false, after: 0 }, reportReminder: true, autoBackup: { enabled: true } });
    // Al guardar los datos de nuevo ya no lo llevan
    await db.saveData(data!);
    expect((mocks.kv.get('data') as { settings: object }).settings).not.toHaveProperty('reportReminder');
  });
  it('solo la primera vez: después manda lo del teléfono', async () => {
    mocks.kv.set('data', withReminder(true));
    mocks.kv.set('device', { lock: { enabled: true, after: 60 }, reportReminder: false });
    const { db, device } = await fresh();
    await db.loadData();
    expect(await device.loadDevice()).toEqual({ lock: { enabled: true, after: 60 }, reportReminder: false, autoBackup: { enabled: true } });
  });
  it('apagado (o algo raro) no crea nada', async () => {
    for (const on of [undefined, false, 'sí']) {
      mocks.kv.clear();
      mocks.kv.set('data', withReminder(on));
      const { db } = await fresh();
      await db.loadData();
      expect(mocks.kv.has('device')).toBe(false);
    }
  });
  it('un respaldo no trae el aviso: es del teléfono que lo programó', async () => {
    const { normalizeData } = await import('../../domain/template');
    expect(normalizeData(withReminder(true)).settings).not.toHaveProperty('reportReminder');
  });
});
