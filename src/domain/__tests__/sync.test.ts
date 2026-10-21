import { describe, expect, it } from 'vitest';
import { stableStringify } from '../hash';
import {
  cursorOf,
  diffRecords,
  fromRecords,
  hashRecord,
  latestByKey,
  localChanges,
  mergeRemote,
  mergeShared,
  newRecoveryToken,
  outRecords,
  parseKey,
  pendingKeys,
  presentHashes,
  readRecord,
  recordHashes,
  recordKey,
  replaceWithRemote,
  SETTINGS_ID,
  sharedSettings,
  sumIntoHousehold,
  syncable,
  tombstones,
  toRecords,
  type RemoteRecord,
  type SharedSettings,
  type SyncRecord,
} from '../sync';
import { defaultSettings, normalizeData, templateData } from '../template';
import type { Data, Movement } from '../types';

const mov = (id: string, amount: number, extra: Partial<Movement> = {}): Movement => ({
  id,
  date: '2026-10-20',
  amount,
  kind: 'gasto',
  rubroId: 'r1',
  origin: 'manual',
  createdAt: 1,
  ...extra,
});

const sample = (): Data =>
  normalizeData({
    categories: [{ id: 'c1', name: 'Alimentación', kind: 'gasto', icon: 'm:super', color: '#2a78d6', budget: { type: 'fixed', amount: 1000 }, order: 0 }],
    rubros: [{ id: 'r1', name: 'Feria', categoryId: 'c1', keywords: ['feria'] }],
    movements: [mov('m1', 100), mov('m2', 50, { note: 'Pan' })],
    invoices: [{ id: 'f1', fileName: 'ticket.jpg', mime: 'image/jpeg', items: [{ description: 'Pan', amount: 60 }], createdAt: 1 }],
    goals: [{ id: 'g1', name: 'Viaje', icon: 'plane', target: 1000, saved: 100 }],
    recurring: [{ id: 'q1', rubroId: 'r1', kind: 'gasto', amount: 500, day: 5, createdAt: 1 }],
    settings: {
      ...defaultSettings(),
      name: 'Ana',
      ai: { apiKey: 'sk-ant-secreta', model: 'claude-opus-5-5' },
      onboarded: true,
      learned: { disco: 'r1' },
      usdRate: 40.1,
      lastReportSeen: '2026-09',
    },
  });

let clock = Date.parse('2026-10-21T12:00:00.000Z');
const rem = (kind: SyncRecord['kind'], id: string, data: unknown, opts: { deleted?: boolean; at?: string } = {}): RemoteRecord => ({
  kind,
  id,
  data,
  updatedAt: opts.at ?? new Date((clock += 1000)).toISOString(),
  updatedBy: 'u-otro',
  deleted: opts.deleted ?? false,
});

/** Como vuelve del servidor: JSON con las claves en otro orden (jsonb) */
function viaServer(v: unknown): unknown {
  const reorder = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(reorder);
    return Object.fromEntries(Object.entries(x).reverse().map(([k, y]) => [k, reorder(y)]));
  };
  return reorder(JSON.parse(JSON.stringify(v)));
}
const asRemote = (records: SyncRecord[]): RemoteRecord[] => records.map((r) => rem(r.kind, r.id, viaServer(r.data)));

describe('los datos como registros', () => {
  it('un registro por cosa y uno solo de ajustes', () => {
    const recs = toRecords(sample());
    expect(recs.map((r) => recordKey(r.kind, r.id))).toEqual([
      'category:c1', 'rubro:r1', 'movement:m1', 'movement:m2', 'invoice:f1', 'goal:g1', 'recurring:q1', `settings:${SETTINGS_ID}`,
    ]);
  });

  it('los ajustes compartidos: moneda, lo aprendido y la cotización; nada de la persona ni del teléfono', () => {
    const s = toRecords(sample()).find((r) => r.kind === 'settings')!.data as Record<string, unknown>;
    expect(Object.keys(s).sort()).toEqual(['currency', 'learned', 'usdRate']);
    expect(JSON.stringify(s)).not.toContain('sk-ant');
    expect(JSON.stringify(s)).not.toContain('Ana');
    // Sin cotización, la clave no va
    const d = sample();
    expect(sharedSettings({ ...d.settings, usdRate: undefined })).not.toHaveProperty('usdRate');
  });

  it('la llave para volver a entrar no viaja al hogar (va en los respaldos: está en los datos)', () => {
    const token = newRecoveryToken();
    const d = normalizeData({ ...sample(), settings: { ...sample().settings, recovery: { token, householdId: 'h1', householdName: 'Casa' } } });
    expect(d.settings.recovery?.token).toBe(token);
    expect(JSON.stringify(toRecords(d))).not.toContain(token);
    expect(localChanges(recordHashes(toRecords(sample())), d)).toEqual({ changed: [], deleted: [] });
    // Al recibir lo del hogar, queda la de acá
    expect(fromRecords(asRemote(toRecords(sample())), d).settings.recovery?.token).toBe(token);
  });

  it('las llaves: 43 letras al azar (base64url); una rota o corta se descarta al leer los datos', () => {
    const a = newRecoveryToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newRecoveryToken()).not.toBe(a);
    const read = (recovery: unknown) => normalizeData({ settings: { ...defaultSettings(), recovery } as never }).settings.recovery;
    expect(read({ token: 'corta', householdId: 'h' })).toBeUndefined();
    expect(read({ token: a })).toBeUndefined();
    expect(read('x')).toBeUndefined();
    expect(read({ token: a, householdId: 'h' })).toEqual({ token: a, householdId: 'h', householdName: '' });
  });

  it('el hash no depende del orden de las claves ni de lo undefined', () => {
    const a: SyncRecord = { kind: 'movement', id: 'm1', data: mov('m1', 100, { note: undefined }) };
    const b: SyncRecord = { kind: 'movement', id: 'm1', data: viaServer(mov('m1', 100)) };
    expect(hashRecord(a)).toBe(hashRecord(b));
    expect(hashRecord(a)).not.toBe(hashRecord({ ...a, data: mov('m1', 101) }));
    expect(stableStringify({ b: [1, undefined], a: { d: 1, c: null } })).toBe('{"a":{"c":null,"d":1},"b":[1,null]}');
  });

  it('las claves se arman y se leen (también con «:» en el id)', () => {
    expect(parseKey(recordKey('movement', 'm:1'))).toEqual({ kind: 'movement', id: 'm:1' });
    expect(parseKey('otra:x')).toBeNull();
    expect(parseKey('movement:')).toBeNull();
    expect(parseKey('sin-tipo')).toBeNull();
  });

  it('se sincroniza solo con datos propios ya empezados', () => {
    expect(syncable(sample())).toBe(true);
    expect(syncable({ ...sample(), settings: { ...sample().settings, example: true } })).toBe(false);
    expect(syncable({ ...sample(), settings: { ...sample().settings, onboarded: false } })).toBe(false);
  });
});

describe('diffRecords', () => {
  const synced = () => recordHashes(toRecords(sample()));

  it('sin cambios no hay nada para mandar', () => {
    expect(diffRecords(synced(), toRecords(sample()))).toEqual({ changed: [], deleted: [] });
  });

  it('un movimiento editado, uno nuevo y uno borrado', () => {
    const d = sample();
    d.movements = [{ ...d.movements[0], amount: 120 }, mov('m3', 10)];
    const diff = diffRecords(synced(), toRecords(d));
    expect(diff.changed.map((c) => c.key)).toEqual(['movement:m1', 'movement:m3']);
    expect(diff.changed[0].hash).toBe(hashRecord({ kind: 'movement', id: 'm1', data: d.movements[0] }));
    expect(diff.deleted).toEqual([{ kind: 'movement', id: 'm2', key: 'movement:m2' }]);
  });

  it('cambiar el nombre, la clave de Claude o el último resumen no manda nada; lo aprendido sí', () => {
    const d = sample();
    const solo = { ...d, settings: { ...d.settings, name: 'Bruno', ai: { apiKey: 'otra', model: 'x' }, lastReportSeen: '2026-10' } };
    expect(diffRecords(synced(), toRecords(solo)).changed).toEqual([]);
    const aprendio = { ...d, settings: { ...d.settings, learned: { ...d.settings.learned, ute: 'r1' } } };
    expect(diffRecords(synced(), toRecords(aprendio)).changed.map((c) => c.key)).toEqual([`settings:${SETTINGS_ID}`]);
  });

  it('lo de antes también puede venir como registros', () => {
    const d = sample();
    d.goals = [{ ...d.goals[0], saved: 200 }];
    expect(diffRecords(toRecords(sample()), toRecords(d)).changed.map((c) => c.key)).toEqual(['goal:g1']);
  });

  it('un id repetido cuenta una vez (el último)', () => {
    const d = sample();
    d.movements = [mov('m1', 1), mov('m1', 2), d.movements[1]];
    const diff = diffRecords(synced(), toRecords(d));
    expect(diff.changed).toHaveLength(1);
    expect((diff.changed[0].data as Movement).amount).toBe(2);
  });

  it('con el ejemplo o sin empezar (la bienvenida, «Borrar todo») no se manda nada: ni el ejemplo ni lápidas', () => {
    const ejemplo = { ...sample(), movements: [mov('x1', 999)], settings: { ...sample().settings, example: true } };
    expect(localChanges(synced(), ejemplo)).toEqual({ changed: [], deleted: [] });
    const vacio = normalizeData({ settings: defaultSettings() });
    expect(localChanges(synced(), vacio)).toEqual({ changed: [], deleted: [] });
  });

  it('lo que se manda: los cambiados y las lápidas', () => {
    const d = sample();
    d.movements = [d.movements[1]];
    const diff = localChanges({ ...synced(), 'goal:g1': 'viejo' }, d);
    expect(pendingKeys(diff)).toEqual(new Set(['goal:g1', 'movement:m1']));
    expect(outRecords(diff)).toEqual([
      { kind: 'goal', id: 'g1', data: d.goals[0], deleted: false },
      { kind: 'movement', id: 'm1', data: {}, deleted: true },
    ]);
  });
});

describe('mergeRemote', () => {
  const base = () => sharedSettings(sample().settings);

  it('aplica lo nuevo, lo cambiado y las lápidas, y anota qué tiene el servidor', () => {
    const d = sample();
    const incoming = [
      rem('movement', 'm9', mov('m9', 77, { createdBy: 'u-otro' })),
      rem('movement', 'm1', { ...mov('m1', 150), note: 'Corregido' }),
      rem('movement', 'm2', {}, { deleted: true }),
      rem('invoice', 'f1', {}, { deleted: true }),
    ];
    const res = mergeRemote(d, incoming, []);
    expect(res.applied).toEqual(['movement:m9', 'movement:m1', 'movement:m2', 'invoice:f1']);
    expect(res.data.movements.map((m) => [m.id, m.amount])).toEqual([['m1', 150], ['m9', 77]]);
    expect(res.data.movements.find((m) => m.id === 'm9')?.createdBy).toBe('u-otro');
    expect(res.data.invoices).toEqual([]);
    expect(res.removedInvoices).toEqual(['f1']);
    expect(res.hashes['movement:m9']).toBe(hashRecord(incoming[0]));
    expect(res.hashes['movement:m2']).toBeNull();
    // Lo que no vino queda igual (el mismo objeto)
    expect(res.data.goals[0]).toBe(d.goals[0]);
  });

  it('no pisa un cambio de acá sin mandar (tampoco con una lápida)', () => {
    const d = sample();
    const res = mergeRemote(d, [rem('movement', 'm1', mov('m1', 999)), rem('movement', 'm2', {}, { deleted: true })], ['movement:m1', 'movement:m2']);
    expect(res.data).toBe(d);
    expect(res.kept).toEqual(['movement:m1', 'movement:m2']);
    // El servidor igual tiene lo suyo: lo de acá sigue pendiente y se manda (gana el último)
    expect(res.hashes['movement:m1']).toBeTruthy();
    expect(res.hashes['movement:m2']).toBeNull();
  });

  it('de lo que vino dos veces, gana lo más nuevo', () => {
    const res = mergeRemote(sample(), [
      rem('movement', 'm1', mov('m1', 300), { at: '2026-10-21T12:00:05.000Z' }),
      rem('movement', 'm1', mov('m1', 200), { at: '2026-10-21T12:00:01.000Z' }),
    ], []);
    expect(res.data.movements.find((m) => m.id === 'm1')?.amount).toBe(300);
    expect(latestByKey([rem('goal', 'g', {}, { at: '2026-01-01T00:00:00Z' }), rem('goal', 'g', { x: 1 }, { at: '2026-01-01T00:00:00Z' })]).get('goal:g')?.data).toEqual({ x: 1 });
  });

  it('lo roto o de otra versión se ignora sin tocar nada', () => {
    const d = sample();
    const res = mergeRemote(d, [
      rem('movement', 'm1', { ...mov('m1', 1), amount: 'mucho' }),
      rem('category', 'c1', { ...d.categories[0], budget: { type: 'futuro' } }),
      rem('invoice', 'f2', { fileName: 'x.pdf', mime: 'application/pdf', items: [{ description: 1 }], createdAt: 1 }),
      rem('goal', 'g2', 'no es un objeto'),
      rem('settings', 'otro', { learned: {} }),
      rem('settings', SETTINGS_ID, null),
    ], []);
    expect(res.data).toBe(d);
    expect(res.skipped).toHaveLength(6);
    expect(res.hashes).toEqual({});
  });

  it('lo mismo que ya está no cambia nada (devuelve los mismos datos)', () => {
    const d = sample();
    const res = mergeRemote(d, asRemote(toRecords(d)), []);
    expect(res.data).toBe(d);
    expect(res.applied).toEqual([]);
    expect(Object.keys(res.hashes)).toHaveLength(8);
    // Y esos hashes son los de acá: no queda nada pendiente
    expect(localChanges(presentHashes(res.hashes), d)).toEqual({ changed: [], deleted: [] });
  });

  it('con el ejemplo o sin empezar no toca nada', () => {
    const ejemplo = { ...sample(), settings: { ...sample().settings, example: true } };
    const res = mergeRemote(ejemplo, [rem('movement', 'm9', mov('m9', 1))], []);
    expect(res.data).toBe(ejemplo);
    expect(res.hashes).toEqual({});
  });

  it('el id es el del registro; un rubro sin palabras queda con la lista vacía', () => {
    const res = mergeRemote(sample(), [rem('movement', 'm7', mov('otro-id', 5)), rem('rubro', 'r2', { name: 'UTE', categoryId: 'c1' })], []);
    expect(res.data.movements.some((m) => m.id === 'm7')).toBe(true);
    expect(res.data.rubros.find((r) => r.id === 'r2')?.keywords).toEqual([]);
    expect(readRecord('rubro', 'r3', { name: 'x', categoryId: 'c1', keywords: [1] })).toBeNull();
  });

  it('pasa por normalizeData (una cuenta del diezmo rota se descarta)', () => {
    const d = sample();
    const res = mergeRemote(d, [rem('category', 'c1', { ...d.categories[0], ledger: { from: 'ayer', opening: 1 } })], []);
    expect(res.data.categories[0]).not.toHaveProperty('ledger');
  });

  it('los ajustes del hogar: moneda, aprendido y cotización; el nombre y la clave quedan', () => {
    const d = sample();
    const res = mergeRemote(d, [rem('settings', SETTINGS_ID, { currency: { symbol: 'U$S', locale: 'en-US', decimals: 2 }, learned: { ute: 'r1' } })], []);
    expect(res.data.settings.currency).toEqual({ symbol: 'U$S', locale: 'en-US', decimals: 2 });
    expect(res.data.settings.learned).toEqual({ ute: 'r1' });
    expect(res.data.settings.usdRate).toBeUndefined();
    expect(res.data.settings.name).toBe('Ana');
    expect(res.data.settings.ai.apiKey).toBe('sk-ant-secreta');
    expect(res.data.settings.lastReportSeen).toBe('2026-09');
    expect(res.base).toEqual({ currency: { symbol: 'U$S', locale: 'en-US', decimals: 2 }, learned: { ute: 'r1' } });
    // Una moneda rota no se aplica
    const rota = mergeRemote(d, [rem('settings', SETTINGS_ID, { currency: { symbol: 1 }, learned: { a: 'r1' } })], []);
    expect(rota.data.settings.currency).toEqual(d.settings.currency);
    expect(rota.data.settings.learned).toEqual({ a: 'r1' });
  });

  it('ajustes con cambios de los dos lados: se mezclan contra la última versión recibida', () => {
    const d = sample();
    const b: SharedSettings = { currency: d.settings.currency, learned: { disco: 'r1', vieja: 'r1' }, usdRate: 40.1 };
    // Acá se aprendió «tata» y se olvidó «vieja»; allá se aprendió «ute» y cambió la moneda
    const local = { ...d, settings: { ...d.settings, learned: { disco: 'r1', tata: 'r1' } } };
    const remote = { currency: { ...d.settings.currency, decimals: 0 }, learned: { disco: 'r1', vieja: 'r1', ute: 'r1' }, usdRate: 40.1 };
    const res = mergeRemote(local, [rem('settings', SETTINGS_ID, remote)], [`settings:${SETTINGS_ID}`], { base: b });
    expect(res.data.settings.learned).toEqual({ disco: 'r1', tata: 'r1', ute: 'r1' });
    expect(res.data.settings.currency.decimals).toBe(0);
    expect(res.kept).toEqual([`settings:${SETTINGS_ID}`]);
    // Lo mezclado difiere de lo del servidor: queda pendiente y se manda
    const synced = { ...recordHashes(toRecords(local)), ...presentHashes(res.hashes) };
    expect(localChanges(synced, res.data).changed.map((c) => c.key)).toEqual([`settings:${SETTINGS_ID}`]);
  });

  it('mergeShared: lo cambiado acá gana; sin base, gana lo de acá y lo aprendido se suma', () => {
    const cur = base().currency;
    const b: SharedSettings = { currency: cur, learned: { a: '1' }, usdRate: 40 };
    expect(mergeShared(b, { currency: { ...cur, symbol: 'X' }, learned: { a: '1' }, usdRate: 40 }, { currency: { ...cur, symbol: 'Y' }, learned: { a: '2' }, usdRate: 41 }))
      .toEqual({ currency: { ...cur, symbol: 'X' }, learned: { a: '2' }, usdRate: 41 });
    // Lo olvidado allá se olvida acá (si acá no se tocó)
    expect(mergeShared(b, b, { currency: cur, learned: {} }).learned).toEqual({});
    expect(mergeShared(undefined, { currency: cur, learned: { a: '1' } }, { currency: { ...cur, decimals: 0 }, learned: { a: '9', b: '2' }, usdRate: 41 }))
      .toEqual({ currency: cur, learned: { a: '1', b: '2' } });
  });
});

describe('de vuelta a datos', () => {
  it('los registros del hogar reemplazan lo de acá; quedan el nombre, la clave y el último resumen', () => {
    const ana = sample();
    const bruno: Data = normalizeData({
      movements: [mov('b1', 5)],
      settings: { ...defaultSettings(), name: 'Bruno', ai: { apiKey: 'sk-bruno', model: 'x' }, example: true, lastReportSeen: '2026-08' },
    });
    const d = fromRecords(asRemote(toRecords(ana)), bruno);
    expect(d.movements.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(d.categories).toEqual(ana.categories);
    expect(d.invoices).toEqual(ana.invoices);
    expect(d.goals).toEqual(ana.goals);
    expect(d.recurring).toEqual(ana.recurring);
    expect(d.rubros).toEqual(ana.rubros);
    expect(d.settings).toMatchObject({ name: 'Bruno', ai: { apiKey: 'sk-bruno' }, onboarded: true, learned: ana.settings.learned, usdRate: 40.1, lastReportSeen: '2026-08' });
    expect(d.settings.example).toBeUndefined();
  });

  it('ida y vuelta da lo mismo, y sus hashes dejan todo al día', () => {
    const ana = sample();
    const res = replaceWithRemote(asRemote(toRecords(ana)), ana);
    expect(toRecords(res.data)).toEqual(toRecords(ana));
    expect(localChanges(presentHashes(res.hashes), res.data)).toEqual({ changed: [], deleted: [] });
  });

  it('las lápidas no entran y un hogar vacío deja los datos vacíos (ya empezados)', () => {
    const d = replaceWithRemote([rem('movement', 'm1', {}, { deleted: true })], sample());
    expect(d.data.movements).toEqual([]);
    expect(d.data.settings.onboarded).toBe(true);
    expect(presentHashes(d.hashes)).toEqual({});
  });

  it('hasta dónde se recibió: el updated_at más nuevo', () => {
    expect(cursorOf([], null)).toBeNull();
    expect(cursorOf([rem('goal', 'a', {}, { at: '2026-10-21T12:00:01.500Z' }), rem('goal', 'b', {}, { at: '2026-10-21T12:00:00Z' })], null))
      .toBe(Date.parse('2026-10-21T12:00:01.500Z'));
    // Con microsegundos y la zona como la manda Postgres
    expect(cursorOf([rem('goal', 'a', {}, { at: '2026-10-21T12:00:03.123456+00:00' })], Date.parse('2026-10-21T12:00:01Z')))
      .toBe(Date.parse('2026-10-21T12:00:03.123Z'));
    expect(cursorOf([rem('goal', 'a', {}, { at: '2026-10-21T12:00:00Z' })], Date.parse('2026-10-21T12:00:01Z'))).toBe(Date.parse('2026-10-21T12:00:01Z'));
  });
});

describe('sumar mis datos al hogar', () => {
  const cat = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ id, name, kind: 'gasto', icon: 'm:otros', color: '#000', budget: { type: 'none' }, order: 0, ...extra }) as Data['categories'][number];
  const hogar = (): Data =>
    normalizeData({
      ...sample(),
      categories: [...sample().categories, cat('c2', 'Ingresos', { kind: 'ingreso' })],
      rubros: [...sample().rubros, { id: 'r2', name: 'Sueldo', categoryId: 'c2', keywords: [] }],
      movements: [
        ...sample().movements,
        mov('h-ago', 800, { date: '2026-08-01', origin: 'planilla', monthly: true }),
        mov('h-set', 900, { date: '2026-09-01', origin: 'planilla', monthly: true }),
      ],
    });
  const mio = (): Data =>
    normalizeData({
      categories: [cat('k1', 'ALIMENTACION'), cat('k2', 'Mascotas', { budget: { type: 'fixed', amount: 300 } }), cat('k3', 'Vacía'), cat('k4', 'Comida')],
      rubros: [
        { id: 's1', name: 'feria', categoryId: 'k1', keywords: [] },
        { id: 's2', name: 'Veterinaria', categoryId: 'k2', keywords: [] },
        // Otro nombre de categoría, pero el único rubro del hogar que se llama así
        { id: 's3', name: 'Feria ', categoryId: 'k4', keywords: [] },
      ],
      movements: [
        // La misma planilla (otros ids) y un mes que el hogar no tiene
        mov('p-ago', 800, { date: '2026-08-01', origin: 'planilla', monthly: true, rubroId: 's1' }),
        mov('p-set', 950, { date: '2026-09-01', origin: 'planilla', monthly: true, rubroId: 's1' }),
        mov('p-jul', 700, { date: '2026-07-01', origin: 'planilla', monthly: true, rubroId: 's1' }),
        // Igual a uno del hogar (m1: 100 en Feria el 20/10) y otro igual que no está dos veces en el hogar
        mov('x1', 100, { rubroId: 's1' }),
        mov('x2', 100, { rubroId: 's3' }),
        mov('x3', 40, { rubroId: 's2', invoiceId: 'fv', createdBy: 'otro-hogar' }),
        // El mismo id que uno del hogar (un respaldo de ese hogar): queda el del hogar
        mov('m2', 999, { rubroId: 's1' }),
        mov('y1', 10, { rubroId: 's1', invoiceId: 'fy' }),
      ],
      invoices: [
        { id: 'fv', fileName: 'vet.jpg', mime: 'image/jpeg', items: [{ description: 'Consulta', amount: 40, rubroId: 's2' }], createdAt: 1 },
        // Su único movimiento ya estaba en el hogar: el mismo estado de cuenta, no se suma
        { id: 'fx', fileName: 'oca.pdf', mime: 'application/pdf', items: [{ description: 'Feria', amount: 100, rubroId: 's1' }], createdAt: 1 },
        { id: 'fy', fileName: 'ticket.jpg', mime: 'image/jpeg', items: [{ description: 'Pan', amount: 10, rubroId: 's1' }], createdAt: 1 },
      ],
      goals: [{ id: 'g9', name: 'viaje', icon: 'plane', target: 5, saved: 1 }, { id: 'g8', name: 'Auto', icon: 'car', target: 9, saved: 2 }],
      recurring: [
        { id: 'q9', rubroId: 's1', kind: 'gasto', amount: 400, day: 3, createdAt: 1 },
        { id: 'q8', rubroId: 's2', kind: 'gasto', amount: 50, day: 9, createdAt: 1 },
      ],
      settings: { ...defaultSettings(), onboarded: true, learned: { 'la pasiva': 's1', vete: 's2', disco: 's2' }, usdRate: 39 },
    });
  // x1 y fx: el estado de cuenta de x1
  const mine = (): Data => {
    const d = mio();
    return { ...d, movements: d.movements.map((m) => (m.id === 'x1' ? { ...m, invoiceId: 'fx' } : m)) };
  };

  it('une categorías y rubros por nombre y lo de acá pasa a usar los del hogar', () => {
    const { data, added } = sumIntoHousehold(hogar(), mine());
    // «ALIMENTACION» es Alimentación; «Mascotas» (con presupuesto) se suma; «Vacía» y «Comida» sin rubros nuevos, no
    expect(data.categories.map((c) => c.name)).toEqual(['Alimentación', 'Ingresos', 'Mascotas']);
    expect(data.categories.find((c) => c.name === 'Mascotas')?.order).toBe(2);
    expect(data.rubros.map((r) => [r.name, r.categoryId])).toEqual([['Feria', 'c1'], ['Sueldo', 'c2'], ['Veterinaria', 'k2']]);
    expect(added).toMatchObject({ categories: 1, rubros: 1 });
    const byId = new Map(data.movements.map((m) => [m.id, m]));
    expect(byId.get('p-jul')?.rubroId).toBe('r1');
    expect(byId.get('x2')?.rubroId).toBe('r1');
    expect(byId.get('x3')?.rubroId).toBe('s2');
    // Lo sumado queda sin «Anotado por» (lo pone el motor: quien se une)
    expect(byId.get('x3')?.createdBy).toBeUndefined();
    // Del hogar quedan su presupuesto y lo aprendido; lo de acá que el hogar no tiene, se suma (con sus rubros)
    expect(data.categories[0].budget).toEqual({ type: 'fixed', amount: 1000 });
    expect(data.settings.learned).toEqual({ disco: 'r1', 'la pasiva': 'r1', vete: 's2' });
    expect(data.settings.usdRate).toBe(40.1);
  });

  it('no duplica: la planilla de los meses que el hogar ya tiene, lo repetido ni lo del mismo id', () => {
    const { data, added, repeated, sheetMonths } = sumIntoHousehold(hogar(), mine());
    expect(sheetMonths).toEqual(['2026-08', '2026-09']);
    expect(data.movements.filter((m) => m.monthly).map((m) => m.id)).toEqual(['h-ago', 'h-set', 'p-jul']);
    // x1 es igual a m1; x2 también, pero el hogar lo tiene una sola vez; m2 ya estaba
    expect(repeated).toBe(2);
    expect(data.movements.find((m) => m.id === 'm2')?.amount).toBe(50);
    expect(data.movements.map((m) => m.id).filter((id) => /^[xy]/.test(id))).toEqual(['x2', 'x3', 'y1']);
    expect(added.movements).toBe(4);
    // Facturas: la del veterinario y el ticket; el estado de cuenta de x1 (que ya estaba), no
    expect(data.invoices.map((i) => i.id)).toEqual(['f1', 'fv', 'fy']);
    expect(data.invoices.find((i) => i.id === 'fy')?.items[0].rubroId).toBe('r1');
    // La meta «viaje» ya está en el hogar; el fijo de Feria también
    expect(data.goals.map((g) => g.name)).toEqual(['Viaje', 'Auto']);
    expect(data.recurring.map((r) => r.id)).toEqual(['q1', 'q8']);
    expect(added).toMatchObject({ invoices: 2, goals: 1, recurring: 1 });
  });

  it('sumar lo mismo que ya está no cambia nada', () => {
    const hh = hogar();
    const res = sumIntoHousehold(hh, hh);
    expect(res.data).toEqual(hh);
    expect(res.added).toEqual({ movements: 0, categories: 0, rubros: 0, invoices: 0, goals: 0, recurring: 0 });
  });
});

describe('sumar mis datos al hogar: lo borrado, la planilla, los rubros sin uso, las metas y los fijos', () => {
  const lapida = (kind: RemoteRecord['kind'], id: string): RemoteRecord => ({ kind, id, data: null, updatedAt: '2026-10-21T12:00:00.000Z', updatedBy: 'ana', deleted: true });

  it('lo que el hogar borró no vuelve (aunque esté en la copia de acá) y no se le cambia el «Anotado por»', () => {
    const hh = normalizeData({ ...sample(), movements: [mov('m2', 50, { note: 'Pan', createdBy: 'ana' })], goals: [], recurring: [] });
    const mine = normalizeData({
      ...sample(),
      rubros: [...sample().rubros, { id: 'r2', name: 'Carnicería', categoryId: 'c1', keywords: [] }],
      movements: [mov('m1', 100, { createdBy: 'ana' }), mov('m2', 50, { note: 'Pan', createdBy: 'ana' }), mov('m3', 300, { rubroId: 'r2', createdBy: 'ana' }), mov('m4', 70, { createdBy: 'ana' })],
    });
    // Ana borró m1, m3 y el rubro r2 (con su movimiento), la meta y el fijo; m4 es de Ana y sigue en la copia
    const gone = tombstones([lapida('movement', 'm1'), lapida('movement', 'm3'), lapida('rubro', 'r2'), lapida('goal', 'g1'), lapida('recurring', 'q1'),
      { ...lapida('movement', 'm4'), deleted: false, data: mov('m4', 70), updatedAt: '2026-10-21T12:00:01.000Z' }, { ...lapida('movement', 'm4'), updatedAt: '2026-10-21T11:00:00.000Z' }]);
    expect([...gone].sort()).toEqual(['goal:g1', 'movement:m1', 'movement:m3', 'recurring:q1', 'rubro:r2']);
    const res = sumIntoHousehold(hh, mine, gone);
    expect(res.data.movements.map((m) => m.id)).toEqual(['m2', 'm4']);
    expect(res.data.rubros.map((r) => r.id)).toEqual(['r1']);
    expect(res.data.goals).toEqual([]);
    expect(res.data.recurring).toEqual([]);
    expect(res.deleted).toBe(5);
    // m4 ya lo había anotado Ana (alguien del hogar): sigue siendo de Ana, no de quien se une
    expect(res.data.movements.find((m) => m.id === 'm4')?.createdBy).toBe('ana');
  });

  it('un rubro que el hogar borró vuelve si lo usa algo nuevo de acá (como al sincronizar)', () => {
    const hh = normalizeData({ ...sample(), movements: [], goals: [], recurring: [] });
    const mine = normalizeData({ ...sample(), rubros: [...sample().rubros, { id: 'r2', name: 'Carnicería', categoryId: 'c1', keywords: [] }], movements: [mov('nuevo', 300, { rubroId: 'r2' })] });
    const res = sumIntoHousehold(hh, mine, new Set(['rubro:r2']));
    expect(res.data.rubros.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(res.deleted).toBe(0);
  });

  it('la planilla se saltea por mes, rubro y tipo: otra planilla (otros rubros) del mismo mes se suma', () => {
    const hh = normalizeData({ ...sample(), movements: [mov('pa-ago', 800, { date: '2026-08-01', origin: 'planilla', monthly: true })] });
    const mine = normalizeData({
      ...sample(),
      rubros: [...sample().rubros, { id: 'rx', name: 'Alquiler', categoryId: 'c1', keywords: [] }],
      movements: [
        mov('pb-ago', 20000, { date: '2026-08-01', origin: 'planilla', monthly: true, rubroId: 'rx' }),
        mov('pb-ago-ing', 50000, { date: '2026-08-01', origin: 'planilla', monthly: true, rubroId: 'rx', kind: 'ingreso' }),
        mov('pb-ago-feria', 810, { date: '2026-08-01', origin: 'planilla', monthly: true }),
      ],
    });
    const res = sumIntoHousehold(hh, mine);
    expect(res.data.movements.map((m) => m.id)).toEqual(['pa-ago', 'pb-ago', 'pb-ago-ing']);
    expect(res.sheetMonths).toEqual(['2026-08']);
    expect(res.added.movements).toBe(2);
  });

  it('no trae los rubros ni las categorías que no usa nada de lo que se suma (lo que el hogar limpió de la plantilla)', () => {
    const tpl = templateData();
    const edu = tpl.categories.find((c) => c.name === 'Educación')!;
    const hh = normalizeData({
      categories: tpl.categories.filter((c) => c.id !== edu.id),
      rubros: tpl.rubros.filter((r) => r.categoryId !== edu.id).map((r) => (r.name === 'Feria' ? { ...r, name: 'Feria y verdulería' } : r)),
      settings: { ...defaultSettings(), onboarded: true },
    });
    // Otro teléfono que empezó con la plantilla (otros ids) y no anotó nada
    const fresh = templateData();
    const mine = normalizeData({ ...fresh, settings: { ...defaultSettings(), onboarded: true } });
    const res = sumIntoHousehold(hh, mine);
    expect(res.added).toMatchObject({ categories: 0, rubros: 0 });
    expect(res.data.categories.map((c) => c.name)).not.toContain('Educación');
    expect(res.data.rubros.map((r) => r.name)).not.toContain('Feria');
    // Con un gasto en «Librería», vuelven ese rubro y su categoría (y nada más de ella)
    const libreria = fresh.rubros.find((r) => r.name === 'Librería')!;
    const withOne = sumIntoHousehold(hh, { ...mine, movements: [mov('lib', 350, { rubroId: libreria.id })] });
    expect(withOne.added).toMatchObject({ categories: 1, rubros: 1 });
    expect(withOne.data.rubros.filter((r) => r.categoryId === libreria.categoryId).map((r) => r.name)).toEqual(['Librería']);
  });

  it('una categoría nueva con presupuesto trae sus rubros (no queda vacía)', () => {
    const hh = normalizeData({ ...sample(), movements: [], goals: [], recurring: [] });
    const mine = normalizeData({
      ...sample(),
      categories: [...sample().categories, { id: 'k2', name: 'Mascotas', kind: 'gasto', icon: 'm:mascotas', color: '#000000', budget: { type: 'fixed', amount: 300 }, order: 1 }],
      rubros: [...sample().rubros, { id: 's2', name: 'Veterinaria', categoryId: 'k2', keywords: [] }],
      movements: [],
    });
    const res = sumIntoHousehold(hh, mine);
    expect(res.data.rubros.map((r) => r.name)).toEqual(['Feria', 'Veterinaria']);
    expect(res.added).toMatchObject({ categories: 1, rubros: 1 });
  });

  it('una meta con el nombre de una del hogar se junta (lo ahorrado se suma) y un fijo del mismo rubro queda anotado hasta el más nuevo', () => {
    const hh = normalizeData({ ...sample(), movements: [] });
    const mine = normalizeData({
      ...sample(),
      goals: [{ id: 'gb', name: 'viaje', icon: 'plane', target: 5000, saved: 4000 }],
      recurring: [{ id: 'qb', rubroId: 'r1', kind: 'gasto', amount: 450, day: 3, createdAt: 1, doneThrough: '2026-10' }],
      movements: [],
    });
    const res = sumIntoHousehold(hh, mine);
    expect(res.data.goals.map((g) => [g.name, g.target, g.saved])).toEqual([['Viaje', 1000, 4100]]);
    expect(res.goalsJoined).toEqual(['Viaje']);
    expect(res.data.recurring.map((r) => [r.id, r.doneThrough])).toEqual([['q1', '2026-10']]);
    expect(res.recurringKept).toBe(1);
    expect(res.added).toMatchObject({ goals: 0, recurring: 0 });
  });
});
