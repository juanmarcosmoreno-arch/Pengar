import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordKey, SETTINGS_ID } from '../../domain/sync';
import { defaultSettings, emptyData, normalizeData, templateData } from '../../domain/template';
import type { Data, Invoice, Movement } from '../../domain/types';

vi.mock('../platform', () => ({ isNative: false, isPreview: false }));

const { FakeRemote, RemoteError } = await import('../remote');
const { SyncEngine, SyncError, authorLabel, normalizeSyncState, LOST_SESSION } = await import('../sync');
type FakeRemoteT = InstanceType<typeof FakeRemote>;
type Engine = InstanceType<typeof SyncEngine>;

const mov = (id: string, amount: number, extra: Partial<Movement> = {}): Movement => ({
  id, date: '2026-10-20', amount, kind: 'gasto', rubroId: 'r1', origin: 'manual', createdAt: 1, ...extra,
});
const invoice = (id: string): Invoice => ({ id, fileName: `${id}.jpg`, mime: 'image/jpeg', merchant: 'Disco', items: [{ description: 'Pan', amount: 60, rubroId: 'r1' }], total: 60, createdAt: 1 });

const anaData = (): Data => normalizeData({
  categories: [{ id: 'c1', name: 'Alimentación', kind: 'gasto', icon: 'm:super', color: '#2a78d6', budget: { type: 'fixed', amount: 1000 }, order: 0 }],
  rubros: [{ id: 'r1', name: 'Feria', categoryId: 'c1', keywords: ['feria'] }],
  movements: [mov('m1', 100), mov('m2', 50, { invoiceId: 'f1' })],
  invoices: [invoice('f1')],
  goals: [{ id: 'g1', name: 'Viaje', icon: 'plane', target: 1000, saved: 100 }],
  settings: { ...defaultSettings(), name: 'Ana', ai: { apiKey: 'sk-ant-ana', model: 'x' }, onboarded: true, learned: { disco: 'r1' } },
});
const brunoData = (): Data => normalizeData({
  categories: [{ id: 'cb', name: 'Mis gastos', kind: 'gasto', icon: 'm:otros', color: '#eb6834', budget: { type: 'none' }, order: 0 }],
  rubros: [{ id: 'rb', name: 'Varios', categoryId: 'cb', keywords: [] }],
  movements: [mov('b1', 7, { rubroId: 'rb', invoiceId: 'fb' })],
  invoices: [invoice('fb')],
  settings: { ...defaultSettings(), name: 'Bruno', ai: { apiKey: 'sk-ant-bruno', model: 'x' }, onboarded: true, lastReportSeen: '2026-09' },
});

/** Un teléfono: sus datos (lo de la memoria y lo guardado), sus archivos, el estado del motor y el motor */
function phone(server: FakeRemoteT, initial: Data) {
  const client = server.connect();
  const p = {
    client,
    data: initial,
    saved: initial,
    files: new Map<string, Blob>(),
    failSave: false,
    /** El estado del motor no se puede leer (IndexedDB) */
    failLoad: false,
    stateValue: undefined as unknown,
    engine: null as unknown as Engine,
    /** Un cambio de la persona: como store.update (que lo guarda solo) y el aviso del store al motor */
    edit(fn: (d: Data) => Data) {
      p.data = fn(p.data);
      p.saved = p.data;
      p.engine.dataChanged();
    },
    /** La app se cerró de golpe: queda lo guardado */
    async restart() {
      p.engine.stop();
      p.data = p.saved;
      p.engine = make();
      await p.engine.start();
    },
    get state() {
      return normalizeSyncState(p.stateValue);
    },
    get status() {
      return p.engine.getStatus();
    },
  };
  const make = () => new SyncEngine(client, {
    getData: () => p.data,
    setData: (fn) => {
      p.data = fn(p.data);
    },
    saveData: async () => {
      if (p.failSave) throw new Error('sin lugar');
      p.saved = p.data;
    },
    loadFile: async (id) => p.files.get(id),
    saveFile: async (id, b) => void p.files.set(id, b),
    deleteFile: async (id) => void p.files.delete(id),
    pruneFiles: async (keep) => {
      for (const k of [...p.files.keys()]) if (!keep.has(k)) p.files.delete(k);
    },
  }, {
    load: async () => {
      if (p.failLoad) throw new Error('IndexedDB no contesta');
      return structuredClone(p.stateValue);
    },
    save: async (s) => {
      p.stateValue = structuredClone(s);
    },
  }, { listenWindow: false });
  p.engine = make();
  return p;
}
type Phone = ReturnType<typeof phone>;

const movement = (p: Phone, id: string) => p.data.movements.find((m) => m.id === id);
/** Lo compartido de los datos, para comparar dos teléfonos (el orden de las listas no importa) */
const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
const shared = (d: Data) => ({
  categories: byId(d.categories),
  rubros: byId(d.rubros),
  movements: byId(d.movements),
  invoices: byId(d.invoices),
  goals: byId(d.goals),
  recurring: byId(d.recurring),
  currency: d.settings.currency,
  learned: d.settings.learned,
  usdRate: d.settings.usdRate,
});

let server: FakeRemoteT;
let ana: Phone;
let bruno: Phone;

/** Ana crea el hogar y Bruno se une (con lo suyo reemplazado por lo del hogar) */
async function together() {
  ana.files.set('f1', new Blob(['foto de Ana'], { type: 'image/jpeg' }));
  bruno.files.set('fb', new Blob(['foto de Bruno'], { type: 'image/jpeg' }));
  await ana.engine.start();
  await bruno.engine.start();
  const hh = await ana.engine.createHousehold('Casa', 'Ana');
  await bruno.engine.joinHousehold(hh.inviteCode.toLowerCase(), 'Bruno');
  // Lo que quedó programado por los avisos del servidor
  await vi.advanceTimersByTimeAsync(1000);
  return hh;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  server = new FakeRemote();
  ana = phone(server, anaData());
  bruno = phone(server, brunoData());
});
afterEach(() => {
  ana.engine.stop();
  bruno.engine.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('crear y unirse', () => {
  it('sin hogar no hace nada', async () => {
    await ana.engine.start();
    await ana.engine.syncNow();
    expect(ana.status.phase).toBe('off');
    expect(ana.client.calls).toEqual({});
  });

  it('crear un hogar manda todo lo de este teléfono, con los archivos', async () => {
    await ana.engine.start();
    const hh = await ana.engine.createHousehold('Casa de Ana', 'Ana');
    expect(hh.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    const rows = server.records.get(hh.id)!;
    expect([...rows.keys()].sort()).toEqual(['category:c1', 'goal:g1', 'invoice:f1', 'movement:m1', 'movement:m2', 'rubro:r1', `settings:${SETTINGS_ID}`]);
    // Lo de la persona no viaja
    expect(JSON.stringify([...rows.values()])).not.toContain('sk-ant');
    expect(JSON.stringify([...rows.values()])).not.toContain('"Ana"');
    // El archivo no estaba: se sube igual después
    expect(server.files.size).toBe(0);
    expect(ana.status).toMatchObject({ phase: 'idle', pending: 0, household: hh });
    // Los movimientos quedan con quién los anotó
    expect(ana.data.movements.every((m) => m.createdBy === ana.client.userId)).toBe(true);
    expect(ana.state.household).toEqual(hh);
    expect(ana.status.members.map((m) => m.displayName)).toEqual(['Ana']);
  });

  it('sube el archivo de cada factura', async () => {
    const hh = await together();
    expect(await server.files.get(`${hh.id}/f1`)?.text()).toBe('foto de Ana');
  });

  it('con los datos de ejemplo o sin empezar no se puede crear un hogar', async () => {
    await ana.engine.start();
    ana.data = { ...ana.data, settings: { ...ana.data.settings, example: true } };
    await expect(ana.engine.createHousehold('Casa', 'Ana')).rejects.toMatchObject({ kind: 'example' });
    ana.data = emptyData();
    await expect(ana.engine.createHousehold('Casa', 'Ana')).rejects.toBeInstanceOf(SyncError);
    expect(server.households.size).toBe(0);
  });

  it('unirse reemplaza lo de acá por lo del hogar (quedan el nombre y la clave de Claude)', async () => {
    const hh = await together();
    expect(shared(bruno.data)).toEqual(shared(ana.data));
    expect(bruno.data.settings).toMatchObject({ name: 'Bruno', ai: { apiKey: 'sk-ant-bruno' }, onboarded: true, lastReportSeen: '2026-09' });
    // El archivo de su factura de antes se borró; el de Ana todavía no lo tiene
    expect([...bruno.files.keys()]).toEqual([]);
    expect(bruno.status).toMatchObject({ phase: 'idle', pending: 0, household: hh });
    expect(bruno.status.members.map((m) => m.displayName)).toEqual(['Ana', 'Bruno']);
    // Nada de lo de Bruno llegó al hogar
    expect(server.records.get(hh.id)!.has('movement:b1')).toBe(false);
  });

  it('unirse desde la bienvenida (sin datos) deja la app empezada con lo del hogar', async () => {
    bruno.data = emptyData();
    await together();
    expect(bruno.data.settings.onboarded).toBe(true);
    expect(shared(bruno.data)).toEqual(shared(ana.data));
  });

  it('con «sumar lo mío», lo de acá también entra al hogar', async () => {
    bruno.files.set('fb', new Blob(['foto de Bruno']));
    await ana.engine.start();
    const hh = await ana.engine.createHousehold('Casa', 'Ana');
    await bruno.engine.start();
    await bruno.engine.joinHousehold(hh.inviteCode, 'Bruno', { keepLocal: true });
    expect(bruno.data.movements.map((m) => m.id).sort()).toEqual(['b1', 'm1', 'm2']);
    expect(movement(bruno, 'b1')?.createdBy).toBe(bruno.client.userId);
    expect(await server.files.get(`${hh.id}/fb`)?.text()).toBe('foto de Bruno');
    await ana.engine.syncNow();
    expect(shared(ana.data)).toEqual(shared(bruno.data));
  });

  it('un código que no existe no cambia nada', async () => {
    await together();
    const carla = phone(server, brunoData());
    await carla.engine.start();
    await expect(carla.engine.joinHousehold('ZZZZ-ZZZZ', 'Carla')).rejects.toMatchObject({ kind: 'invalid-code' });
    expect(carla.state.household).toBeNull();
    expect(carla.data.movements.map((m) => m.id)).toEqual(['b1']);
    carla.engine.stop();
  });

  it('sin conexión al unirse no cambia nada; después se puede de nuevo', async () => {
    await ana.engine.start();
    const hh = await ana.engine.createHousehold('Casa', 'Ana');
    await bruno.engine.start();
    bruno.client.offline = true;
    await expect(bruno.engine.joinHousehold(hh.inviteCode, 'Bruno')).rejects.toMatchObject({ kind: 'offline' });
    expect(bruno.state.household).toBeNull();
    bruno.client.offline = false;
    await bruno.engine.joinHousehold(hh.inviteCode, 'Bruno');
    expect(shared(bruno.data)).toEqual(shared(ana.data));
  });

  it('ya en un hogar, no se puede crear ni unirse a otro', async () => {
    const hh = await together();
    await expect(ana.engine.createHousehold('Otra', 'Ana')).rejects.toMatchObject({ kind: 'in-household' });
    await expect(bruno.engine.joinHousehold(hh.inviteCode, 'Bruno')).rejects.toMatchObject({ kind: 'in-household' });
  });
});

describe('los dos anotan', () => {
  it('lo que anota cada uno le llega al otro, con quién lo anotó', async () => {
    await together();
    ana.edit((d) => ({ ...d, movements: [...d.movements, mov('a2', 30)] }));
    bruno.edit((d) => ({ ...d, movements: [...d.movements, mov('b2', 40)] }));
    await ana.engine.syncNow();
    await bruno.engine.syncNow();
    await ana.engine.syncNow();
    expect(shared(ana.data)).toEqual(shared(bruno.data));
    expect(movement(ana, 'b2')?.createdBy).toBe(bruno.client.userId);
    expect(movement(bruno, 'a2')?.createdBy).toBe(ana.client.userId);
    expect(ana.status.pending).toBe(0);
    expect(bruno.status.pending).toBe(0);
  });

  it('se manda solo un rato después del cambio (todos los cambios juntos)', async () => {
    await together();
    const before = ana.client.calls.push ?? 0;
    ana.edit((d) => ({ ...d, movements: [...d.movements, mov('a2', 30)] }));
    await vi.advanceTimersByTimeAsync(1000);
    ana.edit((d) => ({ ...d, movements: [...d.movements, mov('a3', 31)] }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ana.client.calls.push ?? 0).toBe(before);
    await vi.advanceTimersByTimeAsync(600);
    expect(ana.client.calls.push).toBe(before + 1);
    expect(server.records.get(ana.state.household!.id)!.has('movement:a3')).toBe(true);
  });

  it('un cambio que no es del hogar (el nombre, la clave de Claude) no manda nada', async () => {
    await together();
    const pulls = ana.client.calls.pull;
    const pushes = ana.client.calls.push;
    ana.edit((d) => ({ ...d, settings: { ...d.settings, name: 'Ana María', ai: { ...d.settings.ai, apiKey: 'otra' } } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(ana.client.calls.push).toBe(pushes);
    expect(ana.client.calls.pull).toBe(pulls);
  });

  it('el otro se entera solo (el servidor avisa)', async () => {
    await together();
    ana.edit((d) => ({ ...d, goals: [{ ...d.goals[0], saved: 300 }] }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(bruno.data.goals[0].saved).toBe(100);
    await vi.advanceTimersByTimeAsync(400);
    expect(bruno.data.goals[0].saved).toBe(300);
  });

  it('el aviso de lo que mandó el mismo teléfono no vuelve a pedir nada', async () => {
    await together();
    const pulls = ana.client.calls.pull;
    ana.edit((d) => ({ ...d, goals: [{ ...d.goals[0], saved: 300 }] }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(ana.client.calls.pull).toBe(pulls + 1);
    expect(bruno.data.goals[0].saved).toBe(300);
  });

  it('y cada minuto con la app abierta, aunque el aviso no llegue', async () => {
    const hh = await together();
    server.silent = true;
    await ana.client.push(hh.id, [{ kind: 'goal', id: 'g1', data: { ...ana.data.goals[0], saved: 600 }, deleted: false }]);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(bruno.data.goals[0].saved).toBe(100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bruno.data.goals[0].saved).toBe(600);
  });

  it('el mismo movimiento editado casi a la vez: gana el último', async () => {
    await together();
    ana.edit((d) => ({ ...d, movements: d.movements.map((m) => (m.id === 'm1' ? { ...m, amount: 200 } : m)) }));
    bruno.edit((d) => ({ ...d, movements: d.movements.map((m) => (m.id === 'm1' ? { ...m, note: 'De Bruno' } : m)) }));
    await ana.engine.syncNow();
    server.tick(500);
    await bruno.engine.syncNow();
    await ana.engine.syncNow();
    // Gana el registro entero de Bruno (el último en llegar)
    expect(movement(ana, 'm1')).toMatchObject({ amount: 100, note: 'De Bruno' });
    expect(shared(ana.data)).toEqual(shared(bruno.data));
  });

  it('lo de acá sin mandar no se pisa con lo que llega: se manda después y gana', async () => {
    await together();
    // Bruno manda primero; Ana sin conexión tenía su cambio
    ana.client.offline = true;
    ana.edit((d) => ({ ...d, movements: d.movements.map((m) => (m.id === 'm1' ? { ...m, amount: 999 } : m)) }));
    await ana.engine.syncNow();
    expect(ana.status.phase).toBe('offline');
    bruno.edit((d) => ({ ...d, movements: d.movements.map((m) => (m.id === 'm1' ? { ...m, amount: 1 } : m)) }));
    await bruno.engine.syncNow();
    ana.client.offline = false;
    await ana.engine.syncNow();
    expect(movement(ana, 'm1')?.amount).toBe(999);
    await bruno.engine.syncNow();
    expect(movement(bruno, 'm1')?.amount).toBe(999);
  });

  it('borrar: se va de los dos lados, con el archivo de la factura', async () => {
    const hh = await together();
    // Bruno abre la factura: la baja la primera vez
    expect(await (await bruno.engine.loadInvoiceFile('f1'))?.text()).toBe('foto de Ana');
    expect(bruno.files.has('f1')).toBe(true);
    ana.edit((d) => ({ ...d, movements: d.movements.filter((m) => m.id !== 'm1'), invoices: [], }));
    await ana.engine.syncNow();
    expect(server.row(hh.id, 'movement', 'm1')).toMatchObject({ deleted: true, data: {} });
    expect(server.row(hh.id, 'invoice', 'f1')?.deleted).toBe(true);
    expect(server.files.has(`${hh.id}/f1`)).toBe(false);
    await bruno.engine.syncNow();
    expect(movement(bruno, 'm1')).toBeUndefined();
    expect(bruno.data.invoices).toEqual([]);
    expect(bruno.files.has('f1')).toBe(false);
    expect(shared(ana.data)).toEqual(shared(bruno.data));
  });

  it('lo aprendido de los dos se junta (y la moneda llega a los dos)', async () => {
    await together();
    ana.edit((d) => ({ ...d, settings: { ...d.settings, learned: { ...d.settings.learned, tata: 'r1' } } }));
    bruno.edit((d) => ({ ...d, settings: { ...d.settings, learned: { ...d.settings.learned, ute: 'r1' }, currency: { ...d.settings.currency, decimals: 0 } } }));
    await ana.engine.syncNow();
    await bruno.engine.syncNow();
    await ana.engine.syncNow();
    expect(ana.data.settings.learned).toEqual({ disco: 'r1', tata: 'r1', ute: 'r1' });
    expect(bruno.data.settings.learned).toEqual(ana.data.settings.learned);
    expect(ana.data.settings.currency.decimals).toBe(0);
    expect(ana.data.settings.name).toBe('Ana');
    expect(bruno.status.pending).toBe(0);
    expect(ana.status.pending).toBe(0);
  });
});

describe('sin conexión', () => {
  it('queda pendiente, reintenta con espera creciente y no pierde nada al cerrar la app', async () => {
    const hh = await together();
    bruno.client.offline = true;
    // Sin el aviso al motor: los reintentos son los únicos que prueban
    bruno.data = bruno.saved = { ...bruno.data, movements: [...bruno.data.movements, mov('b2', 40), mov('b3', 41)] };
    await bruno.engine.syncNow();
    expect(bruno.status).toMatchObject({ phase: 'offline', pending: 2 });
    const tries = () => bruno.client.calls.session ?? 0;
    const t0 = tries();
    // 2 s, después 4 s, después 8 s
    await vi.advanceTimersByTimeAsync(2000);
    expect(tries()).toBe(t0 + 1);
    await vi.advanceTimersByTimeAsync(3900);
    expect(tries()).toBe(t0 + 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(tries()).toBe(t0 + 2);
    await vi.advanceTimersByTimeAsync(8000);
    expect(tries()).toBe(t0 + 3);
    // Se cierra la app sin conexión: al abrir, sigue pendiente
    await bruno.restart();
    expect(bruno.status).toMatchObject({ phase: 'offline', pending: 2 });
    bruno.client.offline = false;
    await bruno.engine.syncNow();
    expect(bruno.status).toMatchObject({ phase: 'idle', pending: 0 });
    expect(server.records.get(hh.id)!.has('movement:b3')).toBe(true);
    await ana.engine.syncNow();
    expect(movement(ana, 'b3')?.amount).toBe(41);
  });

  it('la espera no pasa de 5 minutos', async () => {
    await together();
    bruno.client.offline = true;
    bruno.edit((d) => ({ ...d, movements: [...d.movements, mov('b2', 40)] }));
    await bruno.engine.syncNow();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const t = bruno.client.calls.session ?? 0;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Uno por la espera y, como mucho, uno por el minuto (que también prueba)
    expect((bruno.client.calls.session ?? 0) - t).toBeGreaterThanOrEqual(1);
    expect((bruno.client.calls.session ?? 0) - t).toBeLessThanOrEqual(6);
  });

  it('si la app se cierra antes de guardar lo recibido, lo vuelve a recibir y no manda lo viejo', async () => {
    const hh = await together();
    ana.edit((d) => ({ ...d, movements: d.movements.map((m) => (m.id === 'm1' ? { ...m, amount: 555 } : m)) }));
    await ana.engine.syncNow();
    bruno.failSave = true;
    await bruno.engine.syncNow();
    // En memoria llegó, pero no se pudo guardar: el estado tampoco se guardó
    expect(movement(bruno, 'm1')?.amount).toBe(555);
    expect(bruno.status.phase).toBe('error');
    bruno.failSave = false;
    await bruno.restart();
    expect(movement(bruno, 'm1')?.amount).toBe(555);
    expect(server.row(hh.id, 'movement', 'm1')?.data).toMatchObject({ amount: 555 });
    expect(bruno.status.pending).toBe(0);
  });
});

describe('archivos', () => {
  it('una factura nueva sube su archivo; el otro la baja la primera vez que la abre', async () => {
    const hh = await together();
    ana.files.set('f2', new Blob(['ticket nuevo']));
    ana.edit((d) => ({ ...d, invoices: [...d.invoices, invoice('f2')] }));
    await ana.engine.syncNow();
    expect(await server.files.get(`${hh.id}/f2`)?.text()).toBe('ticket nuevo');
    await bruno.engine.syncNow();
    expect(bruno.files.has('f2')).toBe(false);
    expect(await (await bruno.engine.loadInvoiceFile('f2'))?.text()).toBe('ticket nuevo');
    const downloads = bruno.client.calls.downloadFile;
    expect(await (await bruno.engine.loadInvoiceFile('f2'))?.text()).toBe('ticket nuevo');
    expect(bruno.client.calls.downloadFile).toBe(downloads);
  });

  it('sin conexión, abrir un archivo que no está en el teléfono avisa', async () => {
    await together();
    bruno.client.offline = true;
    await expect(bruno.engine.loadInvoiceFile('f1')).rejects.toBeInstanceOf(RemoteError);
    // El que no está en ningún lado
    bruno.client.offline = false;
    expect(await bruno.engine.loadInvoiceFile('no-existe')).toBeUndefined();
  });

  it('sin conexión el archivo espera; se sube al volver', async () => {
    const hh = await together();
    ana.client.offline = true;
    ana.files.set('f3', new Blob(['offline']));
    ana.edit((d) => ({ ...d, invoices: [...d.invoices, invoice('f3')] }));
    await ana.engine.syncNow();
    await ana.restart();
    ana.client.offline = false;
    await ana.engine.syncNow();
    expect(await server.files.get(`${hh.id}/f3`)?.text()).toBe('offline');
    expect(ana.state.files).toEqual({});
  });

  it('un archivo que no sube no frena los registros', async () => {
    const hh = await together();
    const upload = vi.spyOn(ana.client, 'uploadFile').mockRejectedValueOnce(new RemoteError('other', 'se cortó'));
    ana.files.set('f4', new Blob(['x']));
    ana.edit((d) => ({ ...d, invoices: [...d.invoices, invoice('f4')], goals: [] }));
    await ana.engine.syncNow();
    expect(ana.status.phase).toBe('error');
    expect(server.row(hh.id, 'invoice', 'f4')?.deleted).toBe(false);
    expect(server.row(hh.id, 'goal', 'g1')?.deleted).toBe(true);
    expect(ana.state.files).toEqual({ f4: 'up' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(server.files.has(`${hh.id}/f4`)).toBe(true);
  });
});

describe('salir del hogar', () => {
  it('quien sale se queda con una copia y deja de sincronizar; el último borra el hogar', async () => {
    const hh = await together();
    bruno.edit((d) => ({ ...d, movements: [...d.movements, mov('b9', 9)] }));
    await bruno.engine.leave();
    // Lo último se mandó antes de salir
    expect(server.records.get(hh.id)!.has('movement:b9')).toBe(true);
    expect(bruno.state.household).toBeNull();
    expect(bruno.status).toMatchObject({ phase: 'off', household: null });
    expect(bruno.data.movements.map((m) => m.id).sort()).toEqual(['b9', 'm1', 'm2']);
    expect(await ana.engine.refreshMembers()).toHaveLength(1);
    // Lo que anota después queda en su teléfono
    const pushes = bruno.client.calls.push;
    bruno.edit((d) => ({ ...d, movements: [...d.movements, mov('b10', 10)] }));
    await vi.advanceTimersByTimeAsync(5000);
    await bruno.engine.syncNow();
    expect(bruno.client.calls.push).toBe(pushes);
    expect(server.records.get(hh.id)!.has('movement:b10')).toBe(false);
    // Ana es la última
    await ana.engine.leave();
    expect(server.households.size).toBe(0);
    expect(server.records.size).toBe(0);
    expect(server.files.size).toBe(0);
    expect(ana.data.movements.length).toBe(3);
  });

  it('sin conexión no sale (y no cambia nada)', async () => {
    await together();
    bruno.client.offline = true;
    await expect(bruno.engine.leave()).rejects.toMatchObject({ kind: 'offline' });
    expect(bruno.state.household).not.toBeNull();
  });

  it('si ya no es miembro, queda «removed» y puede volver a unirse', async () => {
    const hh = await together();
    // Por ejemplo, se perdió la sesión: para el servidor es otro usuario
    server.members.set(hh.id, server.members.get(hh.id)!.filter((m) => m.userId !== bruno.client.userId));
    bruno.edit((d) => ({ ...d, movements: [...d.movements, mov('b2', 1)] }));
    await bruno.engine.syncNow();
    expect(bruno.status).toMatchObject({ phase: 'removed', error: 'Ya no estás en este hogar' });
    const calls = bruno.client.calls.push;
    await bruno.engine.syncNow();
    expect(bruno.client.calls.push).toBe(calls);
    await bruno.engine.joinHousehold(hh.inviteCode, 'Bruno', { keepLocal: true });
    expect(bruno.status.phase).toBe('idle');
    expect(server.records.get(hh.id)!.has('movement:b2')).toBe(true);
  });

  it('un código nuevo deja al viejo sin servir', async () => {
    const hh = await together();
    const code = await ana.engine.regenerateCode();
    expect(code).not.toBe(hh.inviteCode);
    expect(ana.status.household?.inviteCode).toBe(code);
    expect(ana.state.household?.inviteCode).toBe(code);
    const carla = phone(server, emptyData());
    await carla.engine.start();
    await expect(carla.engine.joinHousehold(hh.inviteCode, 'Carla')).rejects.toMatchObject({ kind: 'invalid-code' });
    // Bruno se entera del código nuevo
    await bruno.engine.refreshMembers();
    expect(bruno.status.household?.inviteCode).toBe(code);
    carla.engine.stop();
  });

  it('el nombre de cada uno y el del hogar', async () => {
    await together();
    await bruno.engine.setDisplayName('Bruno M.');
    await bruno.engine.renameHousehold('Casa de los dos');
    const members = await ana.engine.refreshMembers();
    expect(members.map((m) => m.displayName)).toEqual(['Ana', 'Bruno M.']);
    expect(ana.status.household?.name).toBe('Casa de los dos');
  });
});

describe('ejemplo y «Borrar todo»', () => {
  it('no tocan el hogar; al volver a tener datos se bajan los del hogar', async () => {
    const hh = await together();
    const before = JSON.stringify([...server.records.get(hh.id)!.values()]);
    // «Borrar todo»
    bruno.edit(() => emptyData());
    await bruno.engine.syncNow();
    expect(bruno.status.phase).toBe('paused');
    expect(bruno.state.reload).toBe(true);
    // «Mirar con datos de ejemplo»
    bruno.edit(() => ({ ...anaData(), movements: [mov('ej1', 1)], settings: { ...anaData().settings, example: true } }));
    await bruno.engine.syncNow();
    // Algo que llega mientras tanto tampoco se mezcla con el ejemplo
    ana.edit((d) => ({ ...d, movements: [...d.movements, mov('a7', 7)] }));
    await ana.engine.syncNow();
    await bruno.engine.syncNow();
    expect(bruno.data.movements.map((m) => m.id)).toEqual(['ej1']);
    expect(server.records.get(hh.id)!.has('movement:ej1')).toBe(false);
    expect(server.records.get(hh.id)!.get('movement:m1')?.deleted).toBe(false);
    // «Empezar de cero»: vuelven los datos del hogar en lugar de la plantilla
    bruno.edit(() => ({ ...emptyData(), ...templateData(), settings: { ...defaultSettings(), name: 'Bruno', onboarded: true } }));
    await bruno.engine.syncNow();
    expect(shared(bruno.data)).toEqual(shared(ana.data));
    expect(bruno.data.settings.name).toBe('Bruno');
    expect(bruno.status).toMatchObject({ phase: 'idle', pending: 0 });
    // Lo del hogar sigue (más lo de Ana)
    expect(JSON.stringify([...server.records.get(hh.id)!.values()]).length).toBeGreaterThan(before.length);
    expect(server.records.get(hh.id)!.get('movement:m1')?.deleted).toBe(false);
  });
});

describe('«Borrar todo» y enseguida «Empezar de cero»', () => {
  it('la plantilla nueva no borra el hogar: se bajan los datos del hogar', async () => {
    const hh = await together();
    const pushes = bruno.client.calls.push;
    bruno.edit(() => emptyData());
    bruno.edit(() => ({ ...emptyData(), ...templateData(), settings: { ...defaultSettings(), name: 'Bruno', onboarded: true } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(bruno.client.calls.push).toBe(pushes);
    expect([...server.records.get(hh.id)!.values()].some((r) => r.deleted)).toBe(false);
    expect(shared(bruno.data)).toEqual(shared(ana.data));
    expect(bruno.state.reload).toBe(false);
  });
});

describe('el servidor no acepta un registro', () => {
  it('los demás se mandan; ese no se reintenta hasta que cambie', async () => {
    const hh = await together();
    server.reject = (r) => r.id === 'malo' && (r.data as Movement).amount === 1;
    ana.edit((d) => ({ ...d, movements: [...d.movements, mov('bueno1', 5), mov('malo', 1), mov('bueno2', 6)] }));
    await ana.engine.syncNow();
    const rows = server.records.get(hh.id)!;
    expect(rows.has('movement:bueno1') && rows.has('movement:bueno2')).toBe(true);
    expect(rows.has('movement:malo')).toBe(false);
    expect(ana.status).toMatchObject({ phase: 'idle', pending: 0, rejected: 1 });
    const pushes = ana.client.calls.push;
    await ana.engine.syncNow();
    expect(ana.client.calls.push).toBe(pushes);
    // Cambió: se vuelve a probar
    ana.edit((d) => ({ ...d, movements: d.movements.map((m) => (m.id === 'malo' ? { ...m, amount: 2 } : m)) }));
    await ana.engine.syncNow();
    expect(rows.get('movement:malo')?.data).toMatchObject({ amount: 2 });
    expect(ana.status.rejected).toBe(0);
  });
});

describe('pantalla de bloqueo (pausa)', () => {
  it('en pausa no trae ni manda nada; al seguir, se pone al día', async () => {
    const hh = await together();
    bruno.engine.pause();
    const pulls = bruno.client.calls.pull;
    ana.edit((d) => ({ ...d, goals: [{ ...d.goals[0], saved: 300 }] }));
    bruno.edit((d) => ({ ...d, movements: [...d.movements, mov('b5', 5)] }));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(bruno.client.calls.pull).toBe(pulls);
    expect(bruno.data.goals[0].saved).toBe(100);
    expect(server.records.get(hh.id)!.has('movement:b5')).toBe(false);
    await bruno.engine.start();
    expect(bruno.data.goals[0].saved).toBe(300);
    expect(server.records.get(hh.id)!.has('movement:b5')).toBe(true);
  });

  it('lo que esperaba para mandarse se manda al pausar (la app puede pasar a segundo plano)', async () => {
    const hh = await together();
    ana.edit((d) => ({ ...d, movements: [...d.movements, mov('a9', 9)] }));
    ana.engine.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(server.records.get(hh.id)!.has('movement:a9')).toBe(true);
    expect(ana.status.pending).toBe(0);
  });
});

describe('integrantes', () => {
  it('quedan guardados: sin conexión se sigue sabiendo quién anotó cada cosa', async () => {
    await together();
    expect(bruno.state.members?.map((m) => m.displayName)).toEqual(['Ana', 'Bruno']);
    bruno.client.offline = true;
    await bruno.restart();
    expect(bruno.status.phase).toBe('offline');
    expect(bruno.status.members.map((m) => m.displayName)).toEqual(['Ana', 'Bruno']);
    const authors = { me: bruno.client.userId, inHousehold: true, names: new Map(bruno.status.members.map((m) => [m.userId, m.displayName ?? ''])) };
    expect(authorLabel(authors, movement(bruno, 'm1')?.createdBy)).toBe('Anotado por Ana');
    expect(authorLabel(authors, bruno.client.userId)).toBeNull();
    expect(authorLabel(authors, undefined)).toBeNull();
    expect(authorLabel(authors, 'alguien-que-se-fue')).toBe('Anotado por otra persona');
    // Sin hogar no se dice quién anotó
    expect(authorLabel({ ...authors, inHousehold: false }, movement(bruno, 'm1')?.createdBy)).toBeNull();
  });

  it('el estado de la sincronización dice cuántos cambios faltan mandar', async () => {
    await together();
    ana.client.offline = true;
    ana.edit((d) => ({ ...d, movements: [...d.movements, mov('a2', 2), mov('a3', 3)] }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(ana.status).toMatchObject({ phase: 'offline', pending: 2 });
    ana.client.offline = false;
    await ana.engine.syncNow();
    expect(ana.status).toMatchObject({ phase: 'idle', pending: 0 });
    expect(ana.status.lastSyncAt).not.toBeNull();
  });
});

describe('estado guardado', () => {
  it('lo roto o de otra versión se descarta', () => {
    expect(normalizeSyncState(null).household).toBeNull();
    expect(normalizeSyncState({ household: { id: 1 } }).household).toBeNull();
    const s = normalizeSyncState({
      household: { id: 'h', name: 'Casa', inviteCode: 'ABCDEFGH', extra: 1 },
      userId: 'u',
      cursor: 'ayer',
      synced: { [recordKey('movement', 'm1')]: 'abc', malo: 3 },
      files: { f1: 'up', f2: 'otra-cosa' },
      reload: 'sí',
    });
    expect(s).toEqual({ v: 1, household: { id: 'h', name: 'Casa', inviteCode: 'ABCDEFGH' }, userId: 'u', cursor: null, synced: { 'movement:m1': 'abc' }, files: { f1: 'up' }, rejected: {}, reload: false });
    const m = normalizeSyncState({
      household: { id: 'h', name: 'Casa', inviteCode: 'ABCDEFGH' },
      members: [{ userId: 'u', displayName: 'Ana', joinedAt: '2026-10-21T12:00:00Z', extra: 1 }, { userId: 2 }, { userId: 'v', displayName: null, joinedAt: 'x' }],
    });
    expect(m.members).toEqual([{ userId: 'u', displayName: 'Ana', joinedAt: '2026-10-21T12:00:00Z' }, { userId: 'v', displayName: null, joinedAt: 'x' }]);
  });
});

// --- Arreglos de la revisión del hogar --------------------------------------------------------------------------

/** El ejemplo puesto después de «Borrar todo» (como en la bienvenida) */
const exampleOn = (p: Phone) => p.edit(() => ({ ...emptyData(), movements: [mov('ej', 1)], settings: { ...defaultSettings(), onboarded: true, example: true } }));

describe('salir del hogar (revisión)', () => {
  it('con el ejemplo puesto no deja salir: el hogar y sus datos siguen (lo del hogar no está en el teléfono)', async () => {
    await ana.engine.start();
    const hh = await ana.engine.createHousehold('Casa', 'Ana');
    ana.edit(() => emptyData());
    exampleOn(ana);
    await ana.engine.syncNow();
    expect(ana.status).toMatchObject({ phase: 'paused', reload: true });
    await expect(ana.engine.leave()).rejects.toMatchObject({ kind: 'not-ready' });
    expect(server.households.has(hh.id)).toBe(true);
    expect(server.records.get(hh.id)!.size).toBeGreaterThan(3);
    expect(ana.state.household).not.toBeNull();
  });

  it('antes de salir baja los archivos que nunca abrió; el último en salir no deja facturas sin foto', async () => {
    await together();
    expect(bruno.files.has('f1')).toBe(false);
    await ana.engine.leave();
    await bruno.engine.leave();
    expect(server.files.size).toBe(0);
    expect(bruno.data.invoices.map((i) => i.id)).toEqual(['f1']);
    expect(await bruno.files.get('f1')?.text()).toBe('foto de Ana');
  });

  it('si un archivo no baja, no sale (y dice cuántos); con «Salir igual», sí', async () => {
    const hh = await together();
    const download = bruno.client.downloadFile.bind(bruno.client);
    bruno.client.downloadFile = async () => {
      throw new RemoteError('other', 'Bajar el archivo: 500');
    };
    const err = await bruno.engine.leave().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'files', count: 1 });
    expect(bruno.state.household).not.toBeNull();
    expect(await ana.engine.refreshMembers()).toHaveLength(2);
    await bruno.engine.leave({ force: true });
    expect(bruno.state.household).toBeNull();
    expect(server.households.has(hh.id)).toBe(true);
    bruno.client.downloadFile = download;
  });

  it('sin conexión no sale aunque falten archivos', async () => {
    await together();
    bruno.client.offline = true;
    await expect(bruno.engine.leave()).rejects.toMatchObject({ kind: 'offline' });
    expect(bruno.state.household).not.toBeNull();
  });

  it('un archivo que no se llegó a subir se sube antes de salir', async () => {
    const hh = await together();
    ana.files.set('f2', new Blob(['foto f2']));
    const upload = ana.client.uploadFile.bind(ana.client);
    ana.client.uploadFile = async () => {
      throw new RemoteError('offline', 'Subir el archivo: sin conexión');
    };
    ana.edit((d) => ({ ...d, invoices: [...d.invoices, invoice('f2')] }));
    await ana.engine.syncNow();
    expect(server.records.get(hh.id)!.has('invoice:f2')).toBe(true);
    expect(ana.state.files).toEqual({ f2: 'up' });
    ana.client.uploadFile = upload;
    await ana.engine.leave();
    expect(await server.files.get(`${hh.id}/f2`)?.text()).toBe('foto f2');
    expect(await bruno.engine.loadInvoiceFile('f2')).toBeDefined();
  });

  it('ya fuera del hogar, «Seguir sin hogar» anda también sin conexión', async () => {
    const hh = await together();
    server.members.set(hh.id, server.members.get(hh.id)!.filter((m) => m.userId !== bruno.client.userId));
    await bruno.engine.refreshMembers();
    expect(bruno.status.phase).toBe('removed');
    bruno.client.offline = true;
    await bruno.engine.leave();
    expect(bruno.state.household).toBeNull();
    expect(bruno.status.phase).toBe('off');
    expect(bruno.data.movements.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });
});

describe('«Borrar todo» y el ejemplo (revisión)', () => {
  it('fuera del hogar sin saberlo, después de «Borrar todo»: no reemplaza lo de acá por un hogar vacío', async () => {
    const hh = await together();
    bruno.edit(() => emptyData());
    await bruno.engine.syncNow();
    expect(bruno.state.reload).toBe(true);
    server.members.set(hh.id, server.members.get(hh.id)!.filter((m) => m.userId !== bruno.client.userId));
    bruno.files.set('fb', new Blob(['foto de Bruno']));
    // Restaura su respaldo
    bruno.edit(() => brunoData());
    await bruno.engine.syncNow();
    expect(bruno.status.phase).toBe('removed');
    expect(bruno.data.movements.map((m) => m.id)).toEqual(['b1']);
    expect(bruno.files.has('fb')).toBe(true);
  });

  it('con «Borrar todo» pendiente no cuenta lo de acá como cambios por mandar', async () => {
    await together();
    bruno.client.offline = true;
    bruno.edit(() => emptyData());
    bruno.edit(() => ({ ...emptyData(), ...templateData(), settings: { ...defaultSettings(), name: 'Bruno', onboarded: true } }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(bruno.status).toMatchObject({ phase: 'offline', pending: 0, reload: true });
  });

  it('«Volver a los datos del hogar» los baja ya; sin conexión no cambia nada', async () => {
    await together();
    bruno.edit(() => emptyData());
    await bruno.engine.syncNow();
    bruno.client.offline = true;
    await expect(bruno.engine.reloadNow()).rejects.toMatchObject({ kind: 'offline' });
    expect(bruno.data.settings.onboarded).toBe(false);
    bruno.client.offline = false;
    bruno.edit((d) => ({ ...d, settings: { ...d.settings, name: 'Bruno' } }));
    await bruno.engine.reloadNow();
    expect(bruno.data.settings).toMatchObject({ onboarded: true, name: 'Bruno' });
    expect(shared(bruno.data)).toEqual(shared(ana.data));
    expect(bruno.status).toMatchObject({ phase: 'idle', reload: false, pending: 0 });
  });

  it('«Borrar todo» mientras el motor no pudo leer su estado: al leerlo, se bajan los datos del hogar (no se borra nada)', async () => {
    const hh = await together();
    bruno.failLoad = true;
    await bruno.restart();
    expect(bruno.status.loaded).toBe(false);
    bruno.edit(() => emptyData());
    bruno.edit(() => ({ ...emptyData(), ...templateData(), settings: { ...defaultSettings(), name: 'Bruno', onboarded: true } }));
    bruno.edit((d) => ({ ...d, movements: [mov('b5', 5, { rubroId: d.rubros[0].id })] }));
    bruno.failLoad = false;
    await bruno.restart();
    await vi.advanceTimersByTimeAsync(2000);
    expect([...server.records.get(hh.id)!.values()].some((r) => r.deleted)).toBe(false);
    expect(shared(bruno.data)).toEqual(shared(ana.data));
  });

  it('y si el estado se lee recién después (al anotar algo), tampoco', async () => {
    const hh = await together();
    bruno.failLoad = true;
    await bruno.restart();
    bruno.edit(() => emptyData());
    bruno.failLoad = false;
    bruno.edit(() => ({ ...emptyData(), ...templateData(), settings: { ...defaultSettings(), name: 'Bruno', onboarded: true } }));
    await vi.advanceTimersByTimeAsync(2000);
    await bruno.engine.syncNow();
    expect([...server.records.get(hh.id)!.values()].some((r) => r.deleted)).toBe(false);
    expect(shared(bruno.data)).toEqual(shared(ana.data));
  });

  it('red de seguridad: una tanda que borraría casi todo el hogar espera que la persona decida', async () => {
    const many = Array.from({ length: 30 }, (_, i) => mov(`x${i}`, i + 1));
    ana.data = { ...ana.data, movements: [...ana.data.movements, ...many] };
    const hh = await together();
    // Datos que no son los del hogar, con el mismo id (algo que el motor no vio)
    bruno.edit((d) => ({ ...d, categories: [], rubros: [], movements: [], invoices: [], goals: [] }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(bruno.status).toMatchObject({ phase: 'held' });
    expect(bruno.status.held).toBeGreaterThanOrEqual(30);
    expect([...server.records.get(hh.id)!.values()].some((r) => r.deleted)).toBe(false);
    await bruno.engine.resolveHeld('reload');
    expect(shared(bruno.data)).toEqual(shared(ana.data));
    // Si la persona dice que sí (o confirmó un reemplazo antes), se manda
    bruno.engine.allowBigDelete();
    bruno.edit((d) => ({ ...d, movements: [] }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(bruno.status.phase).toBe('idle');
    expect(server.records.get(hh.id)!.get('movement:x0')?.deleted).toBe(true);
  });
});

describe('sesión y servidor (revisión)', () => {
  it('sin su sesión, el teléfono no se crea otra: queda fuera del hogar con su aviso', async () => {
    const hh = await together();
    bruno.client.noSession = true;
    bruno.edit((d) => ({ ...d, movements: [...d.movements, mov('b2', 2)] }));
    await bruno.engine.syncNow();
    expect(bruno.status).toMatchObject({ phase: 'removed', error: LOST_SESSION });
    expect(server.records.get(hh.id)!.has('movement:b2')).toBe(false);
    expect(bruno.data.movements.some((m) => m.id === 'b2')).toBe(true);
  });

  it('un envío grande no se vuelve a bajar entero en cada vuelta', async () => {
    const many = Array.from({ length: 300 }, (_, i) => mov(`x${i}`, i + 1));
    ana.data = { ...ana.data, movements: [...ana.data.movements, ...many] };
    await together();
    const pull = bruno.client.pull.bind(bruno.client);
    const sizes: number[] = [];
    bruno.client.pull = async (h, since) => {
      const rows = await pull(h, since);
      sizes.push(rows.length);
      return rows;
    };
    for (let i = 0; i < 3; i++) {
      server.tick(60_000);
      await bruno.engine.syncNow();
    }
    expect(sizes).toHaveLength(3);
    expect(sizes.slice(1)).toEqual([0, 0]);
  });

  it('dos aportes a la misma meta casi a la vez: se suman los dos', async () => {
    await together();
    bruno.client.offline = true;
    ana.edit((d) => ({ ...d, goals: [{ ...d.goals[0], saved: d.goals[0].saved + 50 }] }));
    bruno.edit((d) => ({ ...d, goals: [{ ...d.goals[0], saved: d.goals[0].saved + 30 }] }));
    await vi.advanceTimersByTimeAsync(2000);
    bruno.client.offline = false;
    await bruno.engine.syncNow();
    await ana.engine.syncNow();
    expect(bruno.data.goals[0].saved).toBe(180);
    expect(ana.data.goals[0].saved).toBe(180);
  });

  it('sacar a un integrante (un teléfono que ya no se usa)', async () => {
    const hh = await together();
    await ana.engine.removeMember(bruno.client.userId);
    expect(ana.status.members.map((m) => m.displayName)).toEqual(['Ana']);
    await expect(ana.engine.removeMember(ana.client.userId)).rejects.toBeInstanceOf(SyncError);
    await bruno.engine.syncNow();
    expect(bruno.status.phase).toBe('removed');
    expect(server.isMember(hh.id, bruno.client.userId)).toBe(false);
  });
});
