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
  syncable,
  toRecords,
  type RemoteRecord,
  type SharedSettings,
  type SyncRecord,
} from '../sync';
import { defaultSettings, normalizeData } from '../template';
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
