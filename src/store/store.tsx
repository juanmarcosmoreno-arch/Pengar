/** Estado de la app: los datos en memoria, guardados en el teléfono a medida que cambian. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { learnFrom } from '../domain/classify';
import { distributeTotal } from '../domain/invoice';
import { mergeImport, type ImportResult } from '../domain/importSheet';
import { buildIndex, type Index } from '../domain/stats';
import { emptyData, newId, templateData } from '../domain/template';
import type { Category, Data, Goal, Invoice, InvoiceItem, Movement, Rubro, Settings } from '../domain/types';
import { deleteFile, loadData, saveData, saveFile } from '../lib/db';

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

interface Store {
  data: Data;
  ix: Index;
  ready: boolean;
  update: (fn: (d: Data) => Data) => void;
  addMovement: (m: Omit<Movement, 'id' | 'createdAt'>) => void;
  updateMovement: (id: string, patch: Partial<Movement>) => void;
  deleteMovement: (id: string) => void;
  saveInvoice: (inv: InvoiceToSave) => Promise<number>;
  deleteInvoice: (id: string) => void;
  upsertCategory: (c: Category) => void;
  deleteCategory: (id: string, moveRubrosTo?: string) => void;
  upsertRubro: (r: Rubro) => void;
  /** Borra el rubro; si tiene movimientos, pasan a `mergeInto` */
  deleteRubro: (id: string, mergeInto?: string) => void;
  upsertGoal: (g: Goal) => void;
  deleteGoal: (id: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  startWithTemplate: (name: string) => void;
  applyImport: (res: ImportResult, mode: 'replace' | 'merge', name?: string) => void;
  replaceAll: (d: Data) => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data>(emptyData);
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    loadData()
      .then((d) => d && setData(d))
      .finally(() => setReady(true));
  }, []);

  const update = useCallback((fn: (d: Data) => Data) => {
    setData((prev) => {
      const next = fn(prev);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void saveData(next), 250);
      return next;
    });
  }, []);

  const ix = useMemo(() => buildIndex(data), [data.rubros, data.categories]); // eslint-disable-line react-hooks/exhaustive-deps

  const store = useMemo<Store>(() => ({
    data,
    ix,
    ready,
    update,
    addMovement: (m) => update((d) => ({ ...d, movements: [...d.movements, { ...m, id: newId('m'), createdAt: Date.now() }] })),
    updateMovement: (id, patch) => update((d) => ({ ...d, movements: d.movements.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
    deleteMovement: (id) => update((d) => ({ ...d, movements: d.movements.filter((m) => m.id !== id) })),
    saveInvoice: async (inv) => {
      const id = newId('f');
      await saveFile(id, inv.file);
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
      return movements.length;
    },
    deleteInvoice: (id) => {
      void deleteFile(id);
      update((d) => ({
        ...d,
        invoices: d.invoices.filter((i) => i.id !== id),
        movements: d.movements.map((m) => (m.invoiceId === id ? { ...m, invoiceId: undefined } : m)),
      }));
    },
    upsertCategory: (c) => update((d) => ({
      ...d,
      categories: d.categories.some((x) => x.id === c.id) ? d.categories.map((x) => (x.id === c.id ? c : x)) : [...d.categories, c],
    })),
    deleteCategory: (id, moveTo) => update((d) => ({
      ...d,
      categories: d.categories.filter((c) => c.id !== id),
      rubros: moveTo ? d.rubros.map((r) => (r.categoryId === id ? { ...r, categoryId: moveTo } : r)) : d.rubros.filter((r) => r.categoryId !== id),
    })),
    upsertRubro: (r) => update((d) => ({
      ...d,
      rubros: d.rubros.some((x) => x.id === r.id) ? d.rubros.map((x) => (x.id === r.id ? r : x)) : [...d.rubros, r],
    })),
    deleteRubro: (id, mergeInto) => update((d) => ({
      ...d,
      rubros: d.rubros.filter((r) => r.id !== id),
      movements: mergeInto ? d.movements.map((m) => (m.rubroId === id ? { ...m, rubroId: mergeInto } : m)) : d.movements.filter((m) => m.rubroId !== id),
      settings: {
        ...d.settings,
        learned: Object.fromEntries(Object.entries(d.settings.learned).flatMap(([k, v]) => (v === id ? (mergeInto ? [[k, mergeInto]] : []) : [[k, v]]))),
      },
    })),
    upsertGoal: (g) => update((d) => ({ ...d, goals: d.goals.some((x) => x.id === g.id) ? d.goals.map((x) => (x.id === g.id ? g : x)) : [...d.goals, g] })),
    deleteGoal: (id) => update((d) => ({ ...d, goals: d.goals.filter((g) => g.id !== id) })),
    updateSettings: (patch) => update((d) => ({ ...d, settings: { ...d.settings, ...patch } })),
    startWithTemplate: (name) => update((d) => ({ ...d, ...templateData(), settings: { ...d.settings, name, onboarded: true } })),
    applyImport: (res, mode, name) => update((d) => {
      const settings = { ...d.settings, onboarded: true, ...(name != null ? { name } : {}) };
      if (mode === 'replace') return { ...d, categories: res.categories, rubros: res.rubros, movements: res.movements, settings };
      const merged = mergeImport(d, res);
      return {
        ...d,
        categories: [...d.categories, ...merged.categories],
        rubros: [...d.rubros, ...merged.rubros],
        movements: [...d.movements, ...merged.movements],
        settings,
      };
    }),
    replaceAll: (next) => update(() => next),
  }), [data, ix, ready, update]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore fuera de StoreProvider');
  return s;
}
