// El puente nativo de Capacitor simulado para los recorridos con Playwright: la web cree que corre en el iPhone
// (CapacitorCustomPlatform 'ios') y los plugins PengarLock, App, PengarAI (disponible, sin sugerencias) y PengarBackup
// (una carpeta en memoria) contestan desde acá. Los demás plugins usan su versión web. Desde la prueba:
//   window.__lock.answer('ok' | 'cancel' | 'lockout' | 'failed' …)  contesta el pedido de Face ID que espera
//   window.__lock.calls  los pedidos (su `reason`), window.__lock.cover  cada setPrivacyCover({ enabled })
//   window.__app.emit('appStateChange', { isActive }) / emit('pause')  lo que avisa el iPhone al salir y volver
//   window.__backup.files  Map nombre → { data, modified }; .iCloud  si van a iCloud Drive; .writes  lo escrito;
//   .fail = 'write' | 'list' | 'read'  ese método falla (hasta volverlo a null); .slow = ms  cada write tarda eso (iCloud
//   lento). Los archivos quedan entre recargas (sessionStorage)
export async function mockNative(ctx, { biometry = 'faceID', available = true, iCloud = false } = {}) {
  await ctx.addInitScript(({ biometry, available, iCloud }) => {
    const listeners = new Map();
    let nextId = 0;
    const lock = {
      biometry,
      available,
      calls: [],
      cover: [],
      pending: null,
      answer(code) {
        const p = lock.pending;
        if (!p) throw new Error('No hay ningún pedido de Face ID esperando');
        lock.pending = null;
        if (code === 'ok') p.resolve({});
        else p.reject(Object.assign(new Error(code), { code }));
      },
    };
    window.__lock = lock;
    // La carpeta de respaldos, como si fuera el disco del iPhone: sobrevive a recargar la página
    const KEY = '__pengarBackup';
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    const backup = {
      files: new Map(saved?.files ?? []),
      iCloud: saved?.iCloud ?? iCloud,
      writes: saved?.writes ?? [],
      fail: null,
      slow: 0,
      save() {
        sessionStorage.setItem(KEY, JSON.stringify({ files: [...backup.files], iCloud: backup.iCloud, writes: backup.writes }));
      },
    };
    window.__backup = backup;
    const backupFolder = () => (backup.iCloud ? 'iCloud Drive › Pengar › Respaldos' : 'Archivos › En mi iPhone › Pengar › Respaldos');
    const backupMethod = (method, options) => {
      if (backup.fail === method) return Promise.reject(Object.assign(new Error(`No se pudo ${method === 'write' ? 'guardar' : 'leer'} el respaldo: no hay lugar.`), { code: method }));
      if (method === 'status') return Promise.resolve({ iCloud: backup.iCloud, location: backup.iCloud ? 'icloud' : 'local', folder: backupFolder() });
      if (method === 'write') {
        const done = () => {
          backup.files.set(options.name, { data: options.data, modified: Date.now() });
          backup.writes.push(options.name);
          backup.save();
          return { location: backup.iCloud ? 'icloud' : 'local' };
        };
        return backup.slow ? new Promise((r) => setTimeout(() => r(done()), backup.slow)) : Promise.resolve(done());
      }
      if (method === 'list') {
        const files = [...backup.files].map(([name, f]) => ({ name, size: f.data.length, modified: f.modified })).sort((a, b) => b.modified - a.modified);
        return Promise.resolve({ files });
      }
      if (method === 'read') {
        const f = backup.files.get(options.name);
        return f ? Promise.resolve({ data: f.data }) : Promise.reject(Object.assign(new Error('No se pudo leer el respaldo: no está'), { code: 'read' }));
      }
      if (method === 'remove') {
        backup.files.delete(options.name);
        backup.save();
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error(`PengarBackup.${method} no está simulado`), { code: 'UNIMPLEMENTED' }));
    };
    window.__app = {
      emit(eventName, data = {}) {
        for (const cb of [...(listeners.get(eventName)?.values() ?? [])]) cb(data);
      },
    };
    const promise = (names) => names.map((name) => ({ name, rtype: 'promise' }));
    window.CapacitorCustomPlatform = { name: 'ios', plugins: {} };
    window.Capacitor = {
      PluginHeaders: [
        { name: 'PengarLock', methods: promise(['availability', 'authenticate', 'setPrivacyCover']) },
        { name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, ...promise(['removeListener', 'removeAllListeners', 'getState'])] },
        { name: 'PengarAI', methods: promise(['availability', 'classify']) },
        { name: 'PengarBackup', methods: promise(['status', 'write', 'list', 'read', 'remove']) },
      ],
      nativePromise(plugin, method, options = {}) {
        if (plugin === 'App') {
          if (method === 'removeListener') listeners.get(options.eventName)?.delete(options.callbackId);
          if (method === 'removeAllListeners') listeners.clear();
          return Promise.resolve(method === 'getState' ? { isActive: true } : undefined);
        }
        if (plugin === 'PengarAI') return Promise.resolve(method === 'availability' ? { appleIntelligence: 'available' } : { results: [] });
        if (plugin === 'PengarBackup') return backupMethod(method, options);
        if (plugin !== 'PengarLock') return Promise.reject(Object.assign(new Error(`${plugin} no está simulado`), { code: 'UNIMPLEMENTED' }));
        if (method === 'availability') return Promise.resolve({ biometry: lock.biometry, available: lock.available });
        if (method === 'setPrivacyCover') {
          lock.cover.push(options.enabled);
          return Promise.resolve();
        }
        if (method === 'authenticate') {
          lock.calls.push(options.reason);
          return new Promise((resolve, reject) => {
            lock.pending = { resolve, reject };
          });
        }
        return Promise.reject(Object.assign(new Error(`${plugin}.${method} no está simulado`), { code: 'UNIMPLEMENTED' }));
      },
      nativeCallback(plugin, method, options = {}, callback) {
        const id = String(++nextId);
        if (plugin === 'App' && method === 'addListener') {
          if (!listeners.has(options.eventName)) listeners.set(options.eventName, new Map());
          listeners.get(options.eventName).set(id, callback);
        }
        return id;
      },
    };
  }, { biometry, available, iCloud });
}

/** Salir de la app (a otra o a la pantalla de inicio) y volver, como lo avisa el iPhone */
export const leaveApp = (page) => page.evaluate(() => {
  window.__app.emit('appStateChange', { isActive: false });
  window.__app.emit('pause');
});
// En el iPhone, «resume» (willEnterForeground) llega antes que appStateChange (didBecomeActive)
export const backToApp = (page) => page.evaluate(() => {
  window.__app.emit('resume');
  window.__app.emit('appStateChange', { isActive: true });
});
/** El cartel de Face ID (o el centro de control): la app queda inactiva un momento sin pasar a segundo plano */
export const blink = (page) => page.evaluate(() => {
  window.__app.emit('appStateChange', { isActive: false });
  window.__app.emit('appStateChange', { isActive: true });
});
