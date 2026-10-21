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
    expect(await device.loadDevice()).toEqual({ lock: { enabled: false, after: 0 }, reportReminder: false, autoBackup: { enabled: true }, demo: false, intro: true, forecast: true, dollar: true });
  });
  it('lo guardado vuelve igual', async () => {
    const { device } = await fresh();
    const saved = {
      lock: { enabled: true, after: 300 as const },
      reportReminder: true,
      autoBackup: { enabled: false, last: 1_790_000_000_000, lastHash: 'abc', failed: { at: 1_790_000_100_000, message: 'sin lugar' } },
      demo: true,
      intro: false,
      forecast: false,
      dollar: false,
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
    expect(n({ lock: { enabled: 'sí', after: 30 } })).toEqual({ lock: { enabled: false, after: 0 }, reportReminder: false, autoBackup: auto, demo: false, intro: true, forecast: true, dollar: true });
    expect(n({ lock: { enabled: true, after: 60 }, reportReminder: 1 })).toEqual({ lock: { enabled: true, after: 60 }, reportReminder: false, autoBackup: auto, demo: false, intro: true, forecast: true, dollar: true });
    expect(n({ lock: { enabled: true } })).toEqual({ lock: { enabled: true, after: 0 }, reportReminder: false, autoBackup: auto, demo: false, intro: true, forecast: true, dollar: true });
    // El modo demo, solo si es true
    expect(n({ demo: 'sí' }).demo).toBe(false);
    expect(n({ demo: true }).demo).toBe(true);
    // La animación al abrir, prendida salvo un «no» explícito
    expect(n({ intro: false }).intro).toBe(false);
    expect(n({ intro: 'no' }).intro).toBe(true);
    expect(n({}).intro).toBe(true);
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
    expect(await device.loadDevice()).toEqual({ lock: { enabled: false, after: 0 }, reportReminder: true, autoBackup: { enabled: true }, demo: false, intro: true, forecast: true, dollar: true });
    // Al guardar los datos de nuevo ya no lo llevan
    await db.saveData(data!);
    expect((mocks.kv.get('data') as { settings: object }).settings).not.toHaveProperty('reportReminder');
  });
  it('solo la primera vez: después manda lo del teléfono', async () => {
    mocks.kv.set('data', withReminder(true));
    mocks.kv.set('device', { lock: { enabled: true, after: 60 }, reportReminder: false });
    const { db, device } = await fresh();
    await db.loadData();
    expect(await device.loadDevice()).toEqual({ lock: { enabled: true, after: 60 }, reportReminder: false, autoBackup: { enabled: true }, demo: false, intro: true, forecast: true, dollar: true });
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

describe('modo demo: los datos de verdad y los del demo van aparte', () => {
  const real = { ...emptyData(), settings: { ...emptyData().settings, name: 'Juan', onboarded: true } };
  const demo = { ...emptyData(), settings: { ...emptyData().settings, name: 'Ana', onboarded: true, demo: true } };
  const blob = (s: string) => new Blob([s], { type: 'text/plain' });

  it('cada juego lee y guarda en su clave; el activo es el que dice el store', async () => {
    const { db } = await fresh();
    await db.saveData(real);
    await db.saveData(demo, 'demo');
    expect((mocks.kv.get('data') as typeof real).settings.name).toBe('Juan');
    expect((mocks.kv.get('data-demo') as typeof real).settings.name).toBe('Ana');
    expect((await db.loadData())?.settings.name).toBe('Juan');
    db.setActiveDataset('demo');
    expect((await db.loadData())?.settings.name).toBe('Ana');
    expect((await db.loadData('real'))?.settings.name).toBe('Juan');
    // Guardar en el demo no toca los de verdad
    await db.saveData({ ...demo, settings: { ...demo.settings, name: 'Beto' } });
    expect((mocks.kv.get('data') as typeof real).settings.name).toBe('Juan');
    expect((mocks.kv.get('data-demo') as typeof real).settings.name).toBe('Beto');
  });

  it('los archivos de facturas también: borrar los que sobran del demo no toca los de verdad', async () => {
    const { db } = await fresh();
    await db.saveFile('f1', blob('real'));
    db.setActiveDataset('demo');
    await db.saveFile('f2', blob('demo'));
    expect([...mocks.kv.keys()].sort()).toEqual(['demo-file:f2', 'file:f1']);
    expect(await db.loadFile('f1')).toBeUndefined();
    expect(await db.loadFile('f1', 'real')).toBeDefined();
    // «Rehacer los datos de demo»: se borran todos los del demo
    await db.pruneFiles(new Set());
    expect([...mocks.kv.keys()]).toEqual(['file:f1']);
    // Y al revés: los de verdad no borran los del demo
    await db.saveFile('f3', blob('demo'));
    await db.pruneFiles(new Set(), 'real');
    expect([...mocks.kv.keys()]).toEqual(['demo-file:f3']);
    await db.deleteFile('f3', 'real');
    expect([...mocks.kv.keys()]).toEqual(['demo-file:f3']);
    await db.deleteFile('f3');
    expect(mocks.kv.size).toBe(0);
  });

  it('la migración del aviso del día 1 es solo de los datos de verdad', async () => {
    mocks.kv.set('data-demo', { ...demo, settings: { ...demo.settings, reportReminder: true } });
    const { db } = await fresh();
    await db.loadData('demo');
    expect(mocks.kv.has('device')).toBe(false);
  });
});
