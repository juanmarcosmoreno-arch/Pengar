import { describe, expect, it, vi } from 'vitest';

vi.mock('../platform', () => ({ isNative: false, isPreview: false }));
const { cleanSupabaseKey, cleanSupabaseUrl, FakeRemote, isRemoteConfigured, RemoteError } = await import('../remote');

describe('configuración de Supabase (.env)', () => {
  it('la dirección se limpia de lo que se cuela al copiar y pegar', () => {
    expect(cleanSupabaseUrl('https://abc.supabase.co')).toBe('https://abc.supabase.co');
    expect(cleanSupabaseUrl(' “abc.supabase.co/” ')).toBe('https://abc.supabase.co');
    expect(cleanSupabaseUrl('https://https://abc.supabase.co/rest/v1')).toBe('https://abc.supabase.co');
    expect(cleanSupabaseUrl('http://localhost:54321/')).toBe('http://localhost:54321');
    expect(cleanSupabaseUrl('TU-PROYECTO')).toBeNull();
    expect(cleanSupabaseUrl(undefined)).toBeNull();
  });

  it('la clave pública sí; la secreta nunca', () => {
    expect(cleanSupabaseKey(' "eyJabc" ')).toBe('eyJabc');
    expect(cleanSupabaseKey('sb_publishable_xyz')).toBe('sb_publishable_xyz');
    expect(cleanSupabaseKey('sb_secret_xyz')).toBeNull();
    expect(cleanSupabaseKey('dos palabras')).toBeNull();
    expect(cleanSupabaseKey('')).toBeNull();
  });

  it('sin variables no hay hogar compartido', () => {
    expect(isRemoteConfigured()).toBe(false);
  });
});

describe('FakeRemote sigue las reglas de la migración', () => {
  it('solo los miembros leen y escriben; la hora la pone el servidor', async () => {
    const server = new FakeRemote();
    const ana = server.connect();
    const carla = server.connect();
    const hh = await ana.createHousehold('  ', 'Ana');
    expect(hh.name).toBe('Casa');
    expect(hh.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    await ana.push(hh.id, [{ kind: 'movement', id: 'm1', data: { b: 1, a: undefined, cc: [undefined] }, deleted: false }]);
    // Como jsonb: sin undefined y con las claves en otro orden
    const [row] = await ana.pull(hh.id, null);
    expect(row).toMatchObject({ kind: 'movement', id: 'm1', data: { b: 1, cc: [null] }, deleted: false, updatedBy: ana.userId });
    expect(Object.keys(row.data as object)).toEqual(['b', 'cc']);
    // Carla no puede leer (un error, no un hogar vacío: pengar_pull) ni escribir
    await expect(carla.pull(hh.id, null)).rejects.toMatchObject({ kind: 'denied' });
    await expect(carla.push(hh.id, [])).rejects.toMatchObject({ kind: 'denied' });
    expect(await carla.household(hh.id)).toBeNull();
    // Desde una hora: incluida
    expect(await ana.pull(hh.id, row.updatedAt)).toHaveLength(1);
    expect(await ana.pull(hh.id, new Date(Date.parse(row.updatedAt) + 1).toISOString())).toHaveLength(0);
  });

  it('sin conexión todo falla como sin conexión', async () => {
    const server = new FakeRemote();
    const ana = server.connect();
    ana.offline = true;
    const err = await ana.session().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err).toMatchObject({ kind: 'offline' });
  });
});
