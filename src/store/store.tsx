/** Estado de la app: los datos en memoria, guardados en el teléfono a medida que cambian. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { learnFrom } from '../domain/classify';
import { today } from '../domain/dates';
import { exampleOutdated } from '../domain/example';
import { distributeTotal } from '../domain/invoice';
import { mergeImport, replaceImport, type ImportResult } from '../domain/importSheet';
import { round2 } from '../domain/money';
import { dueMovements } from '../domain/recurring';
import { NOT_SPEND } from '../domain/statementReview';
import { buildIndex, type Index } from '../domain/stats';
import { emptyData, newId, normalizeData, templateData } from '../domain/template';
import type { Category, Data, Goal, Invoice, InvoiceItem, Movement, Recurring, Rubro, Settings } from '../domain/types';
import { restoreFiles, type ReadBackup } from '../lib/backup';
import { deleteFile, loadData, pruneFiles, saveData, saveFile } from '../lib/db';
import { loadExample } from '../lib/example';
import { isPreview } from '../lib/platform';

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
  update: (fn: (d: Data) => Data) => void;
  addMovement: (m: Omit<Movement, 'id' | 'createdAt'>) => void;
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
  /** El fijo ya está anotado (o salteado) hasta `month` */
  markRecurring: (id: string, month: string) => void;
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
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Lo último sin guardar, si se cargó bien lo guardado, y lo que se hace recién con los datos ya guardados
  const pending = useRef<Data>();
  const current = useRef<Data>(data);
  const loaded = useRef(false);
  const afterSave = useRef<(() => Promise<void>)[]>([]);

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
    if (saved && isPreview && exampleOutdated(saved, today())) {
      // El ejemplo guardado es de otro mes: se vuelve a armar para este, con el nombre y la clave que había
      const prev = saved;
      saved = await loadExample().then((ex) => ({ ...ex, settings: { ...ex.settings, name: prev.settings.name, ai: prev.settings.ai } }), () => prev);
    }
    if (saved) setData(saved);
    // La vista previa web abre directo en Inicio, con los datos de ejemplo
    else if (isPreview) await loadExample().then(setData, (e) => console.error(e));
    setReady(true);
  }, []);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    current.current = data;
  }, [data]);

  /** Guarda ya lo pendiente (y después hace lo que esperaba a que se guardara) */
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const next = pending.current;
    if (!next || !loaded.current) return;
    pending.current = undefined;
    const jobs = afterSave.current.splice(0);
    try {
      await saveData(next);
      setSaveError(false);
    } catch (e) {
      console.error(e);
      setSaveError(true);
      pending.current ??= next;
      afterSave.current.unshift(...jobs);
      return;
    }
    for (const job of jobs) await job().catch((e) => console.error(e));
  }, []);

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

  const update = useCallback((fn: (d: Data) => Data) => {
    setData((prev) => {
      const next = fn(prev);
      current.current = next;
      // Si no se pudo leer lo guardado, nada se guarda encima
      if (loaded.current) {
        pending.current = next;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void flush(), 250);
      }
      return next;
    });
  }, [flush]);

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
    update,
    addMovement: (m) => update((d) => ({ ...d, movements: [...d.movements, { ...m, id: newId('m'), createdAt: Date.now() }] })),
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
    upsertCategory: (c) => update((d) => ({
      ...d,
      categories: d.categories.some((x) => x.id === c.id) ? d.categories.map((x) => (x.id === c.id ? c : x)) : [...d.categories, c],
    })),
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
      update(() => normalizeData({ ...b.data, settings: { ...b.data.settings, ...settings } }));
      pruneAfterSave();
    },
  }), [data, ix, ready, loadError, saveError, update, load, flush, whenSaved, pruneAfterSave]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore fuera de StoreProvider');
  return s;
}
