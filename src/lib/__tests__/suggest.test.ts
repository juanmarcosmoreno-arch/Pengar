import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { itemKey, merchantKey } from '../../domain/classify';
import { emptyData, templateData } from '../../domain/template';
import type { Data } from '../../domain/types';

// Los clasificadores con IA y la plataforma, simulados
const mocks = vi.hoisted(() => ({
  appleStatus: vi.fn(),
  apple: vi.fn(),
  claude: vi.fn(),
  platform: { isNative: true, isPreview: false },
}));
vi.mock('../appleAI', () => ({ appleAIStatus: mocks.appleStatus, classifyWithApple: mocks.apple }));
vi.mock('../ai', () => ({ classifyWithClaude: mocks.claude }));
vi.mock('../platform', () => mocks.platform);

const { rubroOptions, suggestRubros } = await import('../suggest');

type Q = { id: string; text: string };

/** Clasificador simulado: responde según el texto (la parte antes del comercio de la factura) */
const answering = (table: Record<string, string>) => async (items: Q[]) =>
  new Map(items.flatMap((it): [string, string][] => {
    const k = Object.keys(table).find((t) => it.text.startsWith(t));
    return k ? [[it.id, table[k]]] : [];
  }));

function makeData(apiKey = ''): Data {
  const d: Data = { ...emptyData(), ...templateData() };
  d.settings = { ...d.settings, ai: { ...d.settings.ai, apiKey } };
  return d;
}
const idOf = (d: Data, name: string) => d.rubros.find((r) => r.name === name)!.id;

beforeEach(() => {
  mocks.appleStatus.mockResolvedValue('available');
  mocks.apple.mockResolvedValue(new Map());
  mocks.claude.mockResolvedValue(new Map());
  mocks.platform.isPreview = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('opciones para la IA', () => {
  it('rubros de gasto no archivados, con la categoría en la pista', () => {
    const d = makeData();
    d.rubros.find((r) => r.name === 'Feria')!.archived = true;
    const { options, hint, rubroOf } = rubroOptions(d);
    expect(options).toContain('Supermercado');
    expect(options).toContain('Comer afuera');
    expect(options).not.toContain('Feria');
    expect(options).not.toContain('Sueldo');
    expect(hint).toContain('Alimentación: Supermercado, Carnicería, Panadería');
    expect(rubroOf('«supermercado»')).toBe(idOf(d, 'Supermercado'));
    expect(rubroOf('Ómnibus y taxi.')).toBe(idOf(d, 'Ómnibus y taxi'));
    expect(rubroOf('Comer afuera (Salidas y extras)')).toBe(idOf(d, 'Comer afuera'));
    expect(rubroOf('Sueldo')).toBeUndefined();
    expect(rubroOf('Inventado')).toBeUndefined();
  });

  it('dos rubros con el mismo nombre llevan la categoría', () => {
    const d = makeData();
    const salud = d.categories.find((c) => c.name === 'Salud')!;
    const transporte = d.categories.find((c) => c.name === 'Transporte')!;
    d.rubros.push({ id: 'r-otros-s', name: 'Otros', categoryId: salud.id, keywords: [] });
    d.rubros.push({ id: 'r-otros-t', name: 'Otros', categoryId: transporte.id, keywords: [] });
    const { options, rubroOf } = rubroOptions(d);
    expect(options).toContain('Otros (Salud)');
    expect(options).toContain('Otros (Transporte)');
    expect(options).not.toContain('Otros');
    expect(rubroOf('Otros (Salud)')).toBe('r-otros-s');
    expect(rubroOf('otros (transporte)')).toBe('r-otros-t');
  });
});

describe('suggestRubros', () => {
  it('lo aprendido y las palabras clave no van a la IA', async () => {
    const d = makeData('sk-ant-x');
    d.settings.learned = { [merchantKey('LA PASIVA')]: idOf(d, 'Comer afuera'), [itemKey('Yerba Canarias')!]: idOf(d, 'Supermercado') };
    const res = await suggestRubros([
      { id: 'a', text: 'LA PASIVA', merchant: 'LA PASIVA' },
      { id: 'b', text: 'Yerba Canarias 1kg' },
      { id: 'c', text: 'FARMASHOP 23' },
    ], d);
    expect(res.get('a')).toEqual({ rubroId: idOf(d, 'Comer afuera'), reason: 'aprendido' });
    expect(res.get('b')).toEqual({ rubroId: idOf(d, 'Supermercado'), reason: 'aprendido' });
    expect(res.get('c')).toEqual({ rubroId: idOf(d, 'Farmacia'), reason: 'palabra' });
    expect(mocks.apple).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it('Apple Intelligence primero; lo que no sabe, a Claude', async () => {
    const d = makeData('sk-ant-x');
    mocks.apple.mockImplementation(answering({ 'MOSCA HNOS': 'Librería' }));
    mocks.claude.mockImplementation(answering({ 'BAS ': 'Ropa y calzado' }));
    const res = await suggestRubros([
      { id: '1', text: 'MOSCA HNOS' },
      { id: '2', text: 'BAS TRES CRUCES' },
      { id: '3', text: 'XQZ 123' },
    ], d);
    expect(res.get('1')).toEqual({ rubroId: idOf(d, 'Librería'), reason: 'apple' });
    expect(res.get('2')).toEqual({ rubroId: idOf(d, 'Ropa y calzado'), reason: 'claude' });
    expect(res.has('3')).toBe(false);
    // A Claude solo le llega lo que Apple no supo, con las mismas opciones y la pista
    const [asked, options, opts] = mocks.claude.mock.calls[0];
    expect(asked.map((q: Q) => q.text)).toEqual(['BAS TRES CRUCES', 'XQZ 123']);
    expect(options).toEqual(mocks.apple.mock.calls[0][1]);
    expect(opts).toMatchObject({ apiKey: 'sk-ant-x', model: d.settings.ai.model });
    expect(opts.hint).toContain('Categoría de cada rubro');
  });

  it('sin Apple Intelligence va directo a Claude; sin clave, sin sugerencia', async () => {
    mocks.appleStatus.mockResolvedValue('notEnabled');
    mocks.claude.mockImplementation(answering({ 'MOSCA HNOS': 'Librería' }));
    const withKey = makeData('sk-ant-x');
    expect((await suggestRubros([{ id: '1', text: 'MOSCA HNOS' }], withKey)).get('1')).toEqual({ rubroId: idOf(withKey, 'Librería'), reason: 'claude' });
    expect(mocks.apple).not.toHaveBeenCalled();

    mocks.claude.mockClear();
    expect((await suggestRubros([{ id: '1', text: 'MOSCA HNOS' }], makeData())).size).toBe(0);
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it('no le pregunta a Claude si se pide (factura leída con Claude) ni en la vista previa', async () => {
    const d = makeData('sk-ant-x');
    await suggestRubros([{ id: '1', text: 'MOSCA HNOS' }], d, { claude: false });
    mocks.platform.isPreview = true;
    await suggestRubros([{ id: '1', text: 'MOSCA HNOS' }], d);
    expect(mocks.apple).toHaveBeenCalledTimes(2);
    expect(mocks.claude).not.toHaveBeenCalled();
  });

  it('opciones que no están en la lista no cuentan; tildes, mayúsculas y comillas sí', async () => {
    const d = makeData('sk-ant-x');
    mocks.apple.mockImplementation(answering({ 'MOSCA HNOS': 'Útiles escolares', 'REMISES': '«omnibus y TAXI»', 'KIOSCO': '' }));
    mocks.claude.mockImplementation(answering({ 'MOSCA HNOS': 'Sueldo', 'KIOSCO': 'Varios.' }));
    const res = await suggestRubros([
      { id: '1', text: 'MOSCA HNOS' },
      { id: '2', text: 'REMISES CARRASCO' },
      { id: '3', text: 'KIOSCO EL TITO' },
    ], d);
    expect(res.has('1')).toBe(false);
    expect(res.get('2')).toEqual({ rubroId: idOf(d, 'Ómnibus y taxi'), reason: 'apple' });
    expect(res.get('3')).toEqual({ rubroId: idOf(d, 'Varios'), reason: 'claude' });
  });

  it('un comercio repetido se pregunta una sola vez', async () => {
    const d = makeData();
    mocks.apple.mockImplementation(answering({ 'MOSCA HNOS': 'Librería' }));
    const res = await suggestRubros([
      { id: '1', text: 'MOSCA HNOS' },
      { id: '2', text: 'Mosca Hnos' },
      { id: '3', text: 'MOSCA  HNOS ' },
    ], d);
    expect(mocks.apple.mock.calls[0][0]).toHaveLength(1);
    expect([...res.values()].map((s) => s.reason)).toEqual(['apple', 'apple', 'apple']);
  });

  it('en una factura, la IA ve también el comercio', async () => {
    const d = makeData();
    await suggestRubros([{ id: '1', text: 'NEVEX 800G', merchant: 'Kiosco Pepe' }], d);
    expect(mocks.apple.mock.calls[0][0]).toEqual([{ id: '1', text: 'NEVEX 800G (en Kiosco Pepe)' }]);
  });

  it('si la IA falla, devuelve lo que tenga', async () => {
    const d = makeData('sk-ant-x');
    mocks.apple.mockRejectedValue(new Error('MODEL_ERROR'));
    mocks.claude.mockImplementation(answering({ 'MOSCA HNOS': 'Librería' }));
    const items = [{ id: '1', text: 'MOSCA HNOS' }, { id: '2', text: 'FARMASHOP 23' }];
    const res = await suggestRubros(items, d);
    expect(res.get('1')?.reason).toBe('claude');

    mocks.claude.mockRejectedValue(new Error('401'));
    const res2 = await suggestRubros(items, d);
    expect([...res2.keys()]).toEqual(['2']);

    mocks.appleStatus.mockRejectedValue(new Error('sin plugin'));
    await expect(suggestRubros(items, d)).resolves.toBeInstanceOf(Map);
  });

  it('sin rubros de gasto no pregunta nada', async () => {
    const d = makeData('sk-ant-x');
    d.rubros = d.rubros.filter((r) => d.categories.find((c) => c.id === r.categoryId)?.kind === 'ingreso');
    expect((await suggestRubros([{ id: '1', text: 'MOSCA HNOS' }], d)).size).toBe(0);
    expect(mocks.apple).not.toHaveBeenCalled();
    expect(mocks.claude).not.toHaveBeenCalled();
  });
});
