import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backupName } from '../../domain/autoBackup';
import { addDays } from '../../domain/dates';
import { emptyData } from '../../domain/template';
import type { Data } from '../../domain/types';

// El plugin PengarBackup simulado: una carpeta en memoria
const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failWrite: null as Error | null,
  writes: [] as string[],
  // Para dejar un respaldo «a mitad de camino»
  hold: null as Promise<void> | null,
  // Los archivos de las facturas en el teléfono
  blobs: new Map<string, Blob>(),
}));
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    write: async ({ name, data }: { name: string; data: string }) => {
      await mocks.hold;
      if (mocks.failWrite) throw mocks.failWrite;
      mocks.writes.push(name);
      mocks.files.set(name, data);
      return { location: 'local' };
    },
    list: async () => ({ files: [...mocks.files].map(([name, data]) => ({ name, size: data.length, modified: 0 })) }),
    remove: async ({ name }: { name: string }) => void mocks.files.delete(name),
    read: async ({ name }: { name: string }) => ({ data: mocks.files.get(name) }),
  }),
}));
vi.mock('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => {} }) } }));
vi.mock('../platform', () => ({ isNative: true, isPreview: false }));
vi.mock('../db', () => ({ loadFile: async (id: string) => mocks.blobs.get(id), saveFile: async () => true }));

const { listAutoBackups, maybeAutoBackup, readAutoBackup } = await import('../autoBackup');

const NOW = new Date(2026, 9, 21, 9, 12).getTime();
const mine = (): Data => ({ ...emptyData(), settings: { ...emptyData().settings, name: 'Juan', onboarded: true, ai: { apiKey: 'sk-ant-secreta', model: 'claude-opus-5-5' } } });

beforeEach(() => {
  mocks.files.clear();
  mocks.writes.length = 0;
  mocks.failWrite = null;
  mocks.hold = null;
  mocks.blobs.clear();
  // Los errores se avisan por consola (y quedan en el ajuste)
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('respaldo automático', () => {
  it('escribe «pengar-AAAA-MM-DD.json» con el respaldo de siempre (sin la clave de Claude)', async () => {
    const res = await maybeAutoBackup(mine(), { enabled: true }, { now: NOW });
    expect(res.saved).toEqual({ name: 'pengar-2026-10-21.json', location: 'local' });
    expect(res.state?.last).toBe(NOW);
    expect(res.state?.lastHash).toBeTruthy();
    const written = JSON.parse(mocks.files.get('pengar-2026-10-21.json')!);
    expect(written.pengar).toBe(1);
    expect(written.data.settings.name).toBe('Juan');
    expect(written.data.settings.ai.apiKey).toBe('');
    // Y se lee como un respaldo elegido a mano
    const back = await readAutoBackup('pengar-2026-10-21.json');
    expect(back.data.settings.name).toBe('Juan');
  });
  it('después de escribir, borra los que sobran', async () => {
    for (let i = 0; i < 30; i++) mocks.files.set(backupName(addDays('2026-09-21', i)), '{}');
    mocks.files.set('mio.json', '{}');
    await maybeAutoBackup(mine(), { enabled: true }, { now: NOW });
    const left = [...mocks.files.keys()].sort();
    // Los 14 más nuevos (del 8/10 al 21/10), el último de setiembre y lo que no es automático
    expect(left).toHaveLength(16);
    expect(left).toContain('mio.json');
    expect(left).toContain('pengar-2026-09-30.json');
    expect(left).toContain('pengar-2026-10-08.json');
    expect(left).not.toContain('pengar-2026-10-07.json');
  });
  it('si no toca, no escribe nada', async () => {
    const first = await maybeAutoBackup(mine(), { enabled: true }, { now: NOW });
    const again = await maybeAutoBackup(mine(), { enabled: true, ...first.state }, { now: NOW + 60_000 });
    expect(again).toEqual({ skipped: 'today' });
    expect(mocks.writes).toHaveLength(1);
  });
  it('si falla, no tira: el error queda en el ajuste', async () => {
    mocks.failWrite = new Error('No se pudo guardar el respaldo: no hay lugar');
    const res = await maybeAutoBackup(mine(), { enabled: true }, { now: NOW });
    expect(res.error).toBe('No se pudo guardar el respaldo: no hay lugar');
    expect(res.state).toEqual({ failed: { at: NOW, message: 'No se pudo guardar el respaldo: no hay lugar' } });
    expect(res.state).not.toHaveProperty('last');
  });
  it('una app compilada sin el plugin lo dice', async () => {
    mocks.failWrite = Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' });
    const res = await maybeAutoBackup(mine(), { enabled: true }, { now: NOW });
    expect(res.error).toMatch(/^Esta versión de la app no tiene el respaldo automático/);
  });
  it('la lista para restaurar va por el día del nombre, del más nuevo al más viejo', async () => {
    for (const name of ['pengar-2026-10-01.json', 'mio.json', 'pengar-2026-10-20.json', 'pengar-2026-09-15.json']) mocks.files.set(name, '{}');
    expect((await listAutoBackups()).map((f) => f.name)).toEqual(['pengar-2026-10-20.json', 'pengar-2026-10-01.json', 'pengar-2026-09-15.json', 'mio.json']);
  });
  it('uno a la vez: el automático que llega con otro en curso no hace nada; «ahora» espera y se hace', async () => {
    let release = () => {};
    mocks.hold = new Promise((r) => { release = r; });
    const first = maybeAutoBackup(mine(), { enabled: true }, { now: NOW });
    expect(await maybeAutoBackup(mine(), { enabled: true }, { now: NOW })).toEqual({ skipped: 'busy' });
    const forced = maybeAutoBackup(mine(), { enabled: true }, { now: NOW, force: true });
    release();
    expect((await first).saved).toBeTruthy();
    expect((await forced).saved).toBeTruthy();
    expect(mocks.writes).toEqual(['pengar-2026-10-21.json', 'pengar-2026-10-21.json']);
  });

  it('los archivos de las facturas van aparte, una sola vez (no en cada respaldo) y vuelven al restaurar', async () => {
    const inv = (id: string) => ({ id, fileName: `${id}.jpg`, mime: 'image/jpeg', items: [], createdAt: 1 });
    mocks.blobs.set('f1', new Blob(['foto 1'], { type: 'image/jpeg' }));
    mocks.blobs.set('f2', new Blob(['foto 2'], { type: 'image/jpeg' }));
    const data = { ...mine(), invoices: [inv('f1'), inv('f2')] };
    const first = await maybeAutoBackup(data, { enabled: true }, { now: NOW });
    expect(mocks.writes.sort()).toEqual(['pengar-2026-10-21.json', 'pengar-archivo-f1.json', 'pengar-archivo-f2.json']);
    const written = JSON.parse(mocks.files.get('pengar-2026-10-21.json')!);
    expect(written.files).toEqual({});
    expect(written.fileRefs).toEqual(['f1', 'f2']);
    expect(first.state?.archived).toEqual({ f1: '2026-10-21', f2: '2026-10-21' });
    // Al día siguiente, con una factura más: solo se escribe la nueva
    mocks.writes.length = 0;
    mocks.blobs.set('f3', new Blob(['foto 3'], { type: 'image/jpeg' }));
    const next = await maybeAutoBackup({ ...data, invoices: [...data.invoices, inv('f3')] }, { enabled: true, ...first.state }, { now: NOW + 86_400_000 });
    expect(mocks.writes.sort()).toEqual(['pengar-2026-10-22.json', 'pengar-archivo-f3.json']);
    expect(next.state?.archived?.f1).toBe('2026-10-22');
    // Restaurar el del 21 trae sus dos archivos; la lista para restaurar no los muestra
    const back = await readAutoBackup('pengar-2026-10-21.json');
    expect(Object.keys(back.files).sort()).toEqual(['f1', 'f2']);
    expect(atob(back.files.f1.base64)).toBe('foto 1');
    expect((await listAutoBackups()).map((f) => f.name)).toEqual(['pengar-2026-10-22.json', 'pengar-2026-10-21.json']);
  });
});

describe('leer un respaldo', () => {
  it('uno con una lista rota no se acepta (dejaría la app en blanco)', async () => {
    const { readBackup } = await import('../backup');
    const read = (data: unknown) => readBackup(new Blob([JSON.stringify({ pengar: 1, data, files: {} })]));
    const ok = { version: 2, categories: [], rubros: [], movements: [], invoices: [], goals: [], recurring: [], settings: { name: 'X', onboarded: true } };
    await expect(read(ok)).resolves.toMatchObject({ data: { settings: { name: 'X' } } });
    await expect(read({ ...ok, movements: {} })).rejects.toThrow('Este archivo no es un respaldo de Pengar.');
    await expect(read({ ...ok, categories: 'no' })).rejects.toThrow('Este archivo no es un respaldo de Pengar.');
    await expect(read({ ...ok, invoices: [{ fileName: 'sin id' }] })).rejects.toThrow('Este archivo no es un respaldo de Pengar.');
    await expect(read({ ...ok, settings: 'x' })).rejects.toThrow('Este archivo no es un respaldo de Pengar.');
  });
});
