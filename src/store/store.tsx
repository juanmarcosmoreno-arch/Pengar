/** Estado de la app: los datos en memoria, guardados en el teléfono a medida que cambian. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { learnFrom } from '../domain/classify';
import { currentMonth, today } from '../domain/dates';
import { exampleOutdated } from '../domain/example';
import { distributeTotal } from '../domain/invoice';
import { mergeImport, replaceImport, type ImportResult } from '../domain/importSheet';
import { ledgerAfterChange } from '../domain/ledger';
import { round2 } from '../domain/money';
import { dueMovements, skipRecurring as skipRecurringIn } from '../domain/recurring';
import { NOT_SPEND } from '../domain/statementReview';
import { buildIndex, type Index } from '../domain/stats';
import { emptyData, newId, normalizeData, templateData } from '../domain/template';
import type { Category, Data, Goal, Invoice, InvoiceItem, Movement, Recurring, Rubro, Settings } from '../domain/types';
import { canAutoBackup, maybeAutoBackup, onBackground, type AutoBackupRun } from '../lib/autoBackup';
import { restoreFiles, type ReadBackup } from '../lib/backup';
import { deleteFile, loadData, pruneFiles, saveData, saveFile } from '../lib/db';
import { defaultDevice, loadDevice, saveDevice, type Device } from '../lib/device';
import { loadExample } from '../lib/example';
import { isPreview } from '../lib/platform';
import { notifyDataChanged, startSync } from '../lib/sync';

export interface InvoiceToSave {
  file: Blob;
  fileName: string;
  mime: string;
  merchant: string;
  date: string;
  total: number;
  items: InvoiceItem[];
  /** 'split': un movimiento por rubro. 'single': uno solo por el total, en `rubroId` */
  mode: 'split' | 'single';
  rubroId?: string;
  note?: string;
}

/** Estado de cuenta revisado: los gastos (uno por compra) y lo aprendido de cada comercio */
export interface StatementToSave {
  file: Blob;
  fileName: string;
  mime: string;
  card?: string;
  /** Cierre del estado de cuenta */
  date?: string;
  movements: Pick<Movement, 'date' | 'amount' | 'rubroId' | 'merchant' | 'note'>[];
  /** Clave del comercio → rubro (o NOT_SPEND) */
  learned: Settings['learned'];
  usdRate?: number;
}

interface Store {
  data: Data;
  ix: Index;
  ready: boolean;
  /** No se pudieron leer los datos guardados: no se muestra la bienvenida ni se guarda nada encima */
  loadError: boolean;
  retryLoad: () => void;
  /** El último cambio no se pudo guardar en el teléfono (se reintenta con el próximo, o con saveNow) */
  saveError: boolean;
  saveNow: () => void;
  /** Ajustes de este teléfono (bloqueo, aviso del día 1): no van en los datos ni en los respaldos */
  device: Device;
  updateDevice: (patch: Partial<Device>) => void;
  /** «Hacer un respaldo ahora» (el automático, aunque ya haya uno de hoy). Nunca tira: dice cómo salió */
  backupNow: () => Promise<AutoBackupRun>;
  update: (fn: (d: Data) => Data) => void;
  /** Con `id`, ese (el de un gasto fijo del mes); si ya existe, uno nuevo */
  addMovement: (m: Omit<Movement, 'id' | 'createdAt'> & { id?: string }) => void;
  updateMovement: (id: string, patch: Partial<Movement>) => void;
  deleteMovement: (id: string) => void;
  /**
   * Guarda el archivo y los gastos. Tira si el archivo no se pudo guardar (y entonces no guarda nada). `fileKept`:
   * false si el archivo quedó solo mientras la página esté abierta (la vista previa, con el navegador sin lugar)
   */
  saveInvoice: (inv: InvoiceToSave) => Promise<{ count: number; fileKept: boolean }>;
  /** Guarda el archivo y los gastos, y aprende los comercios. Devuelve cuántos gastos y cómo deshacerlo */
  saveStatement: (st: StatementToSave) => Promise<{ count: number; undo: () => void; fileKept: boolean }>;
  deleteInvoice: (id: string) => void;
  upsertCategory: (c: Category) => void;
  deleteCategory: (id: string, moveRubrosTo?: string) => void;
  upsertRubro: (r: Rubro) => void;
  /** Borra el rubro; si tiene movimientos, pasan a `mergeInto` */
  deleteRubro: (id: string, mergeInto?: string) => void;
  upsertGoal: (g: Goal) => void;
  deleteGoal: (id: string) => void;
  upsertRecurring: (r: Recurring) => void;
  deleteRecurring: (id: string) => void;
  /** El fijo ya está anotado hasta `month` */
  markRecurring: (id: string, month: string) => void;
  /** «Saltar» el fijo en `month` (queda hecho hasta ese mes y anotado que se salteó). Devuelve cómo deshacerlo */
  skipRecurring: (id: string, month: string) => () => void;
  /** Anota todos los fijos vencidos del mes con su monto estimado. Devuelve cuántos y cómo deshacerlo */
  recordAllDue: (month: string, todayISO: string) => { count: number; undo: () => void };
  updateSettings: (patch: Partial<Settings>) => void;
  startWithTemplate: (name: string) => void;
  /** Cambia todo por los datos de ejemplo (inventados), con settings.example */
  startWithExample: () => Promise<void>;
  applyImport: (res: ImportResult, mode: 'replace' | 'merge', name?: string) => void;
  /** Cambia todo por `d` (y, ya guardado, borra los archivos de facturas que quedaron sin usar) */
  replaceAll: (d: Data) => void;
  /** Restaurar un respaldo: primero sus archivos, después los datos (con `settings` encima) */
  restoreBackup: (b: ReadBackup, settings: Partial<Settings>) => Promise<void>;
}

/** Los ids de rubro que apuntan a `id` pasan a `to` (o se borran si no hay `to`) */
const remapItems = (invoices: Invoice[], ids: Set<string>, to?: string): Invoice[] =>
  invoices.map((inv) => (inv.items.some((it) => it.rubroId && ids.has(it.rubroId))
    ? { ...inv, items: inv.items.map((it) => (it.rubroId && ids.has(it.rubroId) ? { ...it, rubroId: to } : it)) }
    : inv));

/** Lo aprendido que apunta a rubros que ya no están se olvida (los «no es un gasto» quedan) */
const liveLearned = (learned: Settings['learned'], rubros: Rubro[]): Settings['learned'] => {
  const ids = new Set(rubros.map((r) => r.id));
  return Object.fromEntries(Object.entries(learned).filter(([, v]) => v === NOT_SPEND || ids.has(v)));
};

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data>(emptyData);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [device, setDevice] = useState<Device>(defaultDevice);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Lo último sin guardar, si se cargó bien lo guardado, y lo que se hace recién con los datos ya guardados
  const pending = useRef<Data>();
  const current = useRef<Data>(data);
  const loaded = useRef(false);
  const afterSave = useRef<(() => Promise<void>)[]>([]);
  // Los ajustes del teléfono al día, y los que falta guardar
  const deviceNow = useRef<Device>(device);
  const pendingDevice = useRef<Device>();

  const load = useCallback(async () => {
    setLoadError(false);
    let saved: Data | null;
    try {
      saved = await loadData();
    } catch {
      // Una conexión con IndexedDB que se perdió (pasa en el iPhone): se prueba una vez más con una nueva
      await new Promise((r) => setTimeout(r, 300));
      try {
        saved = await loadData();
      } catch (e) {
        console.error(e);
        setLoadError(true);
        setReady(true);
        return;
      }
    }
    loaded.current = true;
    // Datos de antes, sin id: se les pone uno y se guarda ya (el hogar compartido compara con él; uno que no quedó
    // guardado cambiaría al reabrir). Si no se puede guardar, siguen sin id
    if (saved && !saved.datasetId) {
      const withId = { ...saved, datasetId: newId('d') };
      saved = await saveData(withId).then(() => withId, () => saved);
    }
    // Después de los datos: al leerlos se pasa acá lo que era de este teléfono (lib/db). Si no se pueden leer, de fábrica
    const dev = await loadDevice().catch(() => new Promise((r) => setTimeout(r, 300)).then(loadDevice)).catch((e) => {
      console.error(e);
      return defaultDevice();
    });
    deviceNow.current = dev;
    setDevice(dev);
    if (saved && isPreview && exampleOutdated(saved, today())) {
      // El ejemplo guardado es de otro mes: se vuelve a armar para este, con el nombre y la clave que había
      const prev = saved;
      saved = await loadExample().then((ex) => ({ ...ex, settings: { ...ex.settings, name: prev.settings.name, ai: prev.settings.ai } }), () => prev);
    }
    const show = (d: Data) => {
      current.current = d;
      setData(d);
    };
    if (saved) show(saved);
    // La vista previa web abre directo en Inicio, con los datos de ejemplo
    else if (isPreview) await loadExample().then(show, (e) => console.error(e));
    setReady(true);
  }, []);

  useEffect(() => void load(), [load]);

  /** Guarda ya lo pendiente (y después hace lo que esperaba a que se guardara). false si los datos no se pudieron guardar */
  const flushOnce = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    // Primero los ajustes del teléfono, si cambiaron (si fallan, igual se guardan los datos)
    const dev = pendingDevice.current;
    let devFailed = false;
    if (dev) {
      pendingDevice.current = undefined;
      try {
        await saveDevice(dev);
      } catch (e) {
        console.error(e);
        pendingDevice.current ??= dev;
        devFailed = true;
      }
    }
    const next = pending.current;
    if (!next || !loaded.current) {
      if (dev) setSaveError(devFailed);
      return true;
    }
    pending.current = undefined;
    const jobs = afterSave.current.splice(0);
    try {
      await saveData(next);
      setSaveError(devFailed);
    } catch (e) {
      console.error(e);
      setSaveError(true);
      pending.current ??= next;
      afterSave.current.unshift(...jobs);
      return false;
    }
    for (const job of jobs) await job().catch((e) => console.error(e));
    return true;
  }, []);
  // De a uno: quien espera a que se guarde (el hogar compartido) no sigue mientras otro guardado está a mitad de camino
  const saving = useRef<Promise<boolean>>(Promise.resolve(true));
  const flush = useCallback((): Promise<boolean> => {
    const run = saving.current.then(flushOnce, flushOnce);
    saving.current = run.catch(() => false);
    return run;
  }, [flushOnce]);

  // Al pasar a segundo plano o cerrar, se guarda enseguida: iOS puede cerrar la app antes de los 250 ms
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && void flush();
    const onPageHide = () => void flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flush]);

  // Sobre lo último (no sobre lo ya dibujado) y enseguida: así el hogar compartido (lib/sync) lee al instante lo aplicado
  const update = useCallback((fn: (d: Data) => Data) => {
    const next = fn(current.current);
    current.current = next;
    // Al instante, no después de dibujar: «Borrar todo» seguido de «Empezar de cero» no puede pasar por cambios del hogar
    notifyDataChanged();
    // Si no se pudo leer lo guardado, nada se guarda encima
    if (loaded.current) {
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), 250);
    }
    setData(next);
  }, [flush]);

  // Hogar compartido (lib/sync): con los datos ya leídos, manda lo que cambia y trae lo de los demás. Sin Supabase
  // configurado (y en la vista previa) no hace nada
  useEffect(() => {
    if (!ready || loadError) return;
    return startSync({
      getData: () => current.current,
      setData: update,
      saveData: async () => {
        if (!(await flush())) throw new Error('No se pudieron guardar los datos en el teléfono');
      },
    });
  }, [ready, loadError, update, flush]);

  /** Los ajustes del teléfono se guardan enseguida (con lo que haya pendiente de los datos) */
  const updateDevice = useCallback((patch: Partial<Device>) => {
    const next = { ...deviceNow.current, ...patch };
    deviceNow.current = next;
    pendingDevice.current = next;
    setDevice(next);
    void flush();
  }, [flush]);

  /** Respaldo automático (lib/autoBackup): cómo salió queda en los ajustes del teléfono, para mostrarlo en Ajustes */
  const runBackup = useCallback(async (force: boolean): Promise<AutoBackupRun> => {
    if (!loaded.current) return { skipped: 'empty' };
    const res = await maybeAutoBackup(current.current, deviceNow.current.autoBackup, { force });
    // Sobre lo de ahora: mientras tanto lo pudieron apagar
    if (res.state) updateDevice({ autoBackup: { ...deviceNow.current.autoBackup, ...res.state } });
    return res;
  }, [updateDevice]);

  // Al abrir (un rato después, para no demorar lo primero que se ve) y al pasar a segundo plano
  useEffect(() => {
    if (!ready || loadError || !canAutoBackup) return;
    const timer = setTimeout(() => void runBackup(false), 3000);
    const off = onBackground(() => void runBackup(false));
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [ready, loadError, runBackup]);

  /** Para después de guardar los datos (borrar un archivo antes podría dejar una factura sin archivo) */
  const whenSaved = useCallback((job: () => Promise<void>) => {
    afterSave.current.push(job);
  }, []);

  /** Ya guardados los datos nuevos, se borran los archivos que quedaron sin factura */
  const pruneAfterSave = useCallback(() => whenSaved(() => pruneFiles(new Set(current.current.invoices.map((i) => i.id)))), [whenSaved]);

  const ix = useMemo(() => buildIndex(data), [data.rubros, data.categories]); // eslint-disable-line react-hooks/exhaustive-deps

  const store = useMemo<Store>(() => ({
    data,
    ix,
    ready,
    loadError,
    retryLoad: () => void load(),
    saveError,
    saveNow: () => void flush(),
    device,
    updateDevice,
    backupNow: () => runBackup(true),
    update,
    addMovement: ({ id, ...m }) => update((d) => ({
      ...d,
      movements: [...d.movements, { ...m, id: id && !d.movements.some((x) => x.id === id) ? id : newId('m'), createdAt: Date.now() }],
    })),
    updateMovement: (id, patch) => update((d) => ({ ...d, movements: d.movements.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
    deleteMovement: (id) => update((d) => ({ ...d, movements: d.movements.filter((m) => m.id !== id) })),
    saveInvoice: async (inv) => {
      const id = newId('f');
      const fileKept = await saveFile(id, inv.file);
      const invoice: Invoice = {
        id,
        fileName: inv.fileName,
        mime: inv.mime,
        merchant: inv.merchant || undefined,
        date: inv.date,
        total: inv.total,
        items: inv.items,
        createdAt: Date.now(),
      };
      const groups = new Map<string, number>();
      if (inv.mode === 'single' && inv.rubroId) groups.set(inv.rubroId, inv.total);
      else {
        for (const it of inv.items) if (it.rubroId) groups.set(it.rubroId, (groups.get(it.rubroId) ?? 0) + it.amount);
      }
      const amounts = inv.mode === 'single' ? groups : distributeTotal(groups, inv.total);
      const now = Date.now();
      const movements: Movement[] = [...amounts.entries()]
        .filter(([, amount]) => amount !== 0)
        .map(([rubroId, amount]) => ({
          id: newId('m'),
          date: inv.date,
          amount,
          kind: 'gasto',
          rubroId,
          merchant: inv.merchant || undefined,
          note: inv.note || undefined,
          invoiceId: id,
          origin: 'factura',
          createdAt: now,
        }));
      update((d) => ({
        ...d,
        invoices: [...d.invoices, invoice],
        movements: [...d.movements, ...movements],
        settings: { ...d.settings, learned: learnFrom(d.settings.learned, inv.merchant, inv.mode === 'single' ? inv.items.map((i) => ({ ...i, rubroId: inv.rubroId })) : inv.items) },
      }));
      return { count: movements.length, fileKept };
    },
    saveStatement: async (st) => {
      const id = newId('f');
      const fileKept = await saveFile(id, st.file);
      const now = Date.now();
      const movements: Movement[] = st.movements.map((m, i) => ({
        ...m,
        id: newId('m'),
        kind: 'gasto',
        invoiceId: id,
        origin: 'tarjeta',
        // En el orden del estado de cuenta
        createdAt: now + i,
      }));
      const invoice: Invoice = {
        id,
        kind: 'estado',
        card: st.card,
        fileName: st.fileName,
        mime: st.mime,
        date: st.date,
        total: round2(movements.reduce((s, m) => s + m.amount, 0)),
        items: movements.map((m) => ({ description: m.merchant ?? '', amount: m.amount, rubroId: m.rubroId, date: m.date })),
        createdAt: now,
      };
      update((d) => ({
        ...d,
        invoices: [...d.invoices, invoice],
        movements: [...d.movements, ...movements],
        settings: { ...d.settings, learned: { ...d.settings.learned, ...st.learned }, ...(st.usdRate ? { usdRate: st.usdRate } : {}) },
      }));
      const ids = new Set(movements.map((m) => m.id));
      // Deshacer borra lo creado; lo aprendido queda
      const undo = () => {
        update((d) => ({ ...d, invoices: d.invoices.filter((i) => i.id !== id), movements: d.movements.filter((m) => !ids.has(m.id)) }));
        whenSaved(() => deleteFile(id));
      };
      return { count: movements.length, undo, fileKept };
    },
    deleteInvoice: (id) => {
      update((d) => ({
        ...d,
        invoices: d.invoices.filter((i) => i.id !== id),
        movements: d.movements.map((m) => (m.invoiceId === id ? { ...m, invoiceId: undefined } : m)),
      }));
      whenSaved(() => deleteFile(id));
    },
    upsertCategory: (c) => update((d) => {
      const prev = d.categories.find((x) => x.id === c.id);
      if (!prev) return { ...d, categories: [...d.categories, c] };
      // Cambiar el % del ingreso no recalcula los meses pasados: la cuenta del diezmo sigue con el % de antes hasta acá
      const ledger = ledgerAfterChange(d, buildIndex(d), prev, c, currentMonth());
      const next = ledger === c.ledger ? c : { ...c, ledger };
      return { ...d, categories: d.categories.map((x) => (x.id === c.id ? next : x)) };
    }),
    deleteCategory: (id, moveTo) => update((d) => {
      const rubros = moveTo ? d.rubros.map((r) => (r.categoryId === id ? { ...r, categoryId: moveTo } : r)) : d.rubros.filter((r) => r.categoryId !== id);
      const left = new Set(rubros.map((r) => r.id));
      const gone = new Set(d.rubros.filter((r) => !left.has(r.id)).map((r) => r.id));
      return {
        ...d,
        categories: d.categories.filter((c) => c.id !== id),
        rubros,
        recurring: d.recurring.filter((r) => left.has(r.rubroId)),
        invoices: gone.size ? remapItems(d.invoices, gone) : d.invoices,
      };
    }),
    upsertRubro: (r) => update((d) => ({
      ...d,
      rubros: d.rubros.some((x) => x.id === r.id) ? d.rubros.map((x) => (x.id === r.id ? r : x)) : [...d.rubros, r],
    })),
    deleteRubro: (id, mergeInto) => update((d) => ({
      ...d,
      rubros: d.rubros.filter((r) => r.id !== id),
      movements: mergeInto ? d.movements.map((m) => (m.rubroId === id ? { ...m, rubroId: mergeInto } : m)) : d.movements.filter((m) => m.rubroId !== id),
      // Los renglones de las facturas y estados de cuenta guardados siguen a sus movimientos
      invoices: remapItems(d.invoices, new Set([id]), mergeInto),
      // El fijo pasa al rubro de destino, salvo que ese ya tenga uno
      recurring: d.recurring.flatMap((r) => {
        if (r.rubroId !== id) return [r];
        return mergeInto && !d.recurring.some((x) => x.rubroId === mergeInto) ? [{ ...r, rubroId: mergeInto }] : [];
      }),
      settings: {
        ...d.settings,
        learned: Object.fromEntries(Object.entries(d.settings.learned).flatMap(([k, v]) => (v === id ? (mergeInto ? [[k, mergeInto]] : []) : [[k, v]]))),
      },
    })),
    upsertGoal: (g) => update((d) => ({ ...d, goals: d.goals.some((x) => x.id === g.id) ? d.goals.map((x) => (x.id === g.id ? g : x)) : [...d.goals, g] })),
    deleteGoal: (id) => update((d) => ({ ...d, goals: d.goals.filter((g) => g.id !== id) })),
    upsertRecurring: (r) => update((d) => ({
      ...d,
      recurring: d.recurring.some((x) => x.id === r.id) ? d.recurring.map((x) => (x.id === r.id ? r : x)) : [...d.recurring, r],
    })),
    deleteRecurring: (id) => update((d) => ({ ...d, recurring: d.recurring.filter((r) => r.id !== id) })),
    markRecurring: (id, month) => update((d) => ({
      ...d,
      recurring: d.recurring.map((r) => (r.id === id && (!r.doneThrough || r.doneThrough < month) ? { ...r, doneThrough: month } : r)),
    })),
    skipRecurring: (id, month) => {
      const before = data.recurring.find((r) => r.id === id);
      update((d) => ({ ...d, recurring: d.recurring.map((r) => (r.id === id ? skipRecurringIn(r, month) : r)) }));
      return () => update((d) => ({
        ...d,
        recurring: d.recurring.map((r) => (r.id === id && before ? { ...r, doneThrough: before.doneThrough, skipped: before.skipped } : r)),
      }));
    },
    recordAllDue: (month, todayISO) => {
      // Se arman afuera del update para que los ids sean los mismos al deshacer
      const due = dueMovements(data, month, todayISO);
      const created = due.map((x) => x.movement);
      const ids = new Set(created.map((m) => m.id));
      const marked = new Set(due.map((x) => x.recurringId));
      const before = new Map(data.recurring.filter((r) => marked.has(r.id)).map((r) => [r.id, r.doneThrough]));
      if (created.length) {
        update((d) => ({
          ...d,
          movements: [...d.movements, ...created],
          recurring: d.recurring.map((r) => (before.has(r.id) ? { ...r, doneThrough: month } : r)),
        }));
      }
      const undo = () => update((d) => ({
        ...d,
        movements: d.movements.filter((m) => !ids.has(m.id)),
        recurring: d.recurring.map((r) => (before.has(r.id) ? { ...r, doneThrough: before.get(r.id) } : r)),
      }));
      return { count: created.length, undo };
    },
    updateSettings: (patch) => update((d) => ({ ...d, settings: { ...d.settings, ...patch } })),
    startWithTemplate: (name) => update((d) => ({ ...d, ...templateData(), recurring: [], settings: { ...d.settings, name, onboarded: true, example: undefined } })),
    startWithExample: async () => {
      const ex = await loadExample();
      update((d) => ({ ...ex, settings: { ...ex.settings, ai: d.settings.ai } }));
    },
    applyImport: (res, mode, name) => {
      if (mode === 'replace' && data.settings.example) pruneAfterSave();
      update((d) => {
        const settings = { ...d.settings, onboarded: true, ...(name != null ? { name } : {}) };
        if (mode === 'replace') {
          // Desde el ejemplo se parte de cero: nada de Ana, su meta ni su estado de cuenta (la clave de Claude queda)
          const base = d.settings.example ? { ...emptyData(), settings: { ...emptyData().settings, ai: d.settings.ai } } : d;
          const { categories, rubros } = replaceImport(d, res);
          return {
            ...base,
            categories,
            rubros,
            movements: res.movements,
            recurring: [],
            // Reemplazar todo por una planilla propia ya no es el ejemplo
            settings: { ...base.settings, onboarded: true, ...(name != null ? { name } : {}), example: undefined, learned: liveLearned(base.settings.learned, rubros) },
          };
        }
        const merged = mergeImport(d, res);
        const out = new Set(merged.replaceIds);
        return {
          ...d,
          categories: [...d.categories, ...merged.categories],
          rubros: [...d.rubros, ...merged.rubros],
          movements: [...d.movements.filter((m) => !out.has(m.id)), ...merged.movements],
          settings,
        };
      });
    },
    replaceAll: (next) => {
      update(() => normalizeData(next));
      pruneAfterSave();
    },
    restoreBackup: async (b, settings) => {
      await restoreFiles(b.files);
      // Los ajustes de este teléfono (el bloqueo, el aviso del día 1) no vienen en el respaldo: quedan como estaban. El
      // id de los datos sigue siendo el de acá: en un hogar, lo restaurado es un cambio de estos datos
      update((d) => normalizeData({ ...b.data, datasetId: d.datasetId, settings: { ...b.data.settings, ...settings } }));
      pruneAfterSave();
    },
  }), [data, ix, ready, loadError, saveError, device, updateDevice, runBackup, update, load, flush, whenSaved, pruneAfterSave]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore fuera de StoreProvider');
  return s;
}
