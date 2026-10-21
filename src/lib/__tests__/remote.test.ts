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
    const hh = await ana.createHousehold('  ', 'Ana', 'llave-de-ana-0123456789abcdefghijklmnop');
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

  it('con el código y la llave de un integrante, otro teléfono pasa a ser ese integrante (como pengar_join_household)', async () => {
    const llave = 'llave-de-dani-0123456789abcdefghijklmnop';
    const server = new FakeRemote();
    const ana = server.connect();
    const dani = server.connect();
    const daniNuevo = server.connect();
    const hh = await ana.createHousehold('Casa', 'Ana', 'llave-de-ana-0123456789abcdefghijklmnop');
    expect(await dani.joinHousehold(hh.inviteCode, 'Dani', llave)).toMatchObject({ memberId: dani.userId, reclaimed: false, displayName: 'Dani' });
    expect(await daniNuevo.joinHousehold(hh.inviteCode, '', llave)).toMatchObject({ household: hh, memberId: dani.userId, reclaimed: true, displayName: 'Dani' });
    const members = await ana.members(hh.id);
    expect(members.map((m) => [m.memberId, m.userId])).toEqual([[ana.userId, ana.userId], [dani.userId, daniNuevo.userId]]);
    // La llave no la ve nadie
    expect(JSON.stringify(members)).not.toContain(llave);
    // El teléfono de antes queda afuera
    await expect(dani.pull(hh.id, null)).rejects.toMatchObject({ kind: 'denied' });
    // Otra llave es otro integrante; una corta no sirve
    const otro = server.connect();
    expect(await otro.joinHousehold(hh.inviteCode, 'Otro', 'x'.repeat(43))).toMatchObject({ memberId: otro.userId, reclaimed: false });
    await expect(otro.joinHousehold(hh.inviteCode, 'Otro', 'corta')).rejects.toMatchObject({ kind: 'rejected' });
    // El teléfono de antes de Dani se suma de nuevo con otra llave (para otra persona): otro integrante, con otro id (el
    // de su usuario ya es el de Dani). Como en la base, el id de integrante no se repite en el hogar
    const tablet = await dani.joinHousehold(hh.inviteCode, 'Tablet', 'y'.repeat(43));
    expect(tablet).toMatchObject({ reclaimed: false, displayName: 'Tablet' });
    expect(tablet.memberId).not.toBe(dani.userId);
    const ids = (await ana.members(hh.id)).map((m) => m.memberId);
    expect(new Set(ids).size).toBe(ids.length);
    await dani.leave(hh.id);
    // Si sacan a Dani (por error), con su llave vuelve como el mismo integrante (lo que anotó sigue siendo suyo)
    await ana.removeMember(hh.id, daniNuevo.userId);
    const daniOtroMas = server.connect();
    expect(await daniOtroMas.joinHousehold(hh.inviteCode, null, llave)).toMatchObject({ memberId: dani.userId, reclaimed: true, displayName: 'Dani' });
    // Al salir por su cuenta, no: la app ya borró la llave y, si la manda, es otro integrante
    await daniOtroMas.leave(hh.id);
    const otraVez = server.connect();
    expect(await otraVez.joinHousehold(hh.inviteCode, 'Dani', llave)).toMatchObject({ memberId: otraVez.userId, reclaimed: false });
  });

  it('cambiar el nombre (del hogar o el tuyo) sin ser miembro da «sin permiso», no un «Listo» que no cambió nada', async () => {
    const server = new FakeRemote();
    const ana = server.connect();
    const bruno = server.connect();
    const hh = await ana.createHousehold('Casa', 'Ana', 'llave-de-ana-0123456789abcdefghijklmnop');
    await expect(bruno.renameHousehold(hh.id, 'Hackeado')).rejects.toMatchObject({ kind: 'denied' });
    await expect(bruno.setDisplayName(hh.id, 'Bruno')).rejects.toMatchObject({ kind: 'denied' });
    expect(server.households.get(hh.id)?.name).toBe('Casa');
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
