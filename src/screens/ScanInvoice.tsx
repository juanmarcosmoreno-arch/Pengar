import { Camera, FileText, ImageIcon, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RubroPicker } from '../components/RubroPicker';
import { PageHeader, Sheet } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { Segmented } from '../components/Toggle';
import { useToast } from '../components/Toast';
import { suggestRubro } from '../domain/classify';
import { today } from '../domain/dates';
import { distributeTotal } from '../domain/invoice';
import { parseAmount, round2 } from '../domain/money';
import type { InvoiceItem } from '../domain/types';
import { isPreview } from '../lib/platform';
import { readInvoice, type InvoiceDraft } from '../lib/readInvoice';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

interface Row extends InvoiceItem {
  key: number;
  amountText: string;
}

// En la vista previa web no hay lector de fotos (en el iPhone es Vision; en la web, Tesseract se descarga de otro sitio)
const PHOTOS_IN_APP = 'En la vista web, solo PDF; las fotos se leen en el iPhone';

let rowKey = 0;
const toRow = (i: InvoiceItem): Row => ({ ...i, key: ++rowKey, amountText: String(i.amount).replace('.', ',') });

/** Foto o PDF de una factura → revisar lo leído → guardar como gasto(s) con la factura adjunta */
export function ScanInvoice({ onClose }: { onClose: () => void }) {
  const { data } = useStore();
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const pdf = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setProgress('Leyendo la factura…');
    try {
      setDraft(await readInvoice(file, data, setProgress));
    } catch (e) {
      console.error(e);
      setError(isPreview
        ? 'No pude leer el PDF. En la vista web se leen los PDF con texto (los escaneados, en el iPhone). Probá con otro o cargá el gasto a mano.'
        : 'No pude leer el archivo. Probá con otra foto (bien derecha y con luz) o cargá el gasto a mano.');
    } finally {
      setProgress('');
    }
  };

  const input = (ref: React.RefObject<HTMLInputElement>, accept: string, capture?: boolean) => (
    <input
      ref={ref}
      type="file"
      accept={accept}
      {...(capture ? { capture: 'environment' as const } : {})}
      className="hidden"
      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }}
    />
  );

  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-bg">
      <PageHeader title={draft ? 'Revisar factura' : 'Escanear factura'} onBack={onClose} />
      {input(camera, 'image/*', true)}
      {input(gallery, 'image/*')}
      {input(pdf, 'application/pdf,.pdf')}
      {progress ? (
        <div className="flex flex-col items-center gap-4 px-8 py-24 text-center">
          <Suricata pose="calculadora" size={170} motion="sway" />
          <p className="text-xl">{progress}</p>
          <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-soft border-t-primary" />
        </div>
      ) : draft ? (
        <Review draft={draft} onDone={onClose} onRetry={() => setDraft(null)} />
      ) : (
        <div className="space-y-3 px-4 pb-10">
          <div className="flex justify-center"><Suricata pose="lista" size={150} /></div>
          <p className="px-1 text-lg text-muted">
            Sacale una foto a un ticket o subí el PDF de una factura. Pengar lee el comercio, la fecha, el total y cada renglón, y le pone el rubro.
          </p>
          <button className="card flex w-full items-center gap-4 p-5 text-left disabled:opacity-50" disabled={isPreview} onClick={() => camera.current?.click()}>
            <Camera size={30} className="text-primary" />
            <div><div className="text-xl">Sacar una foto</div><div className="text-muted">{isPreview ? PHOTOS_IN_APP : 'Con el ticket estirado y buena luz'}</div></div>
          </button>
          <button className="card flex w-full items-center gap-4 p-5 text-left disabled:opacity-50" disabled={isPreview} onClick={() => gallery.current?.click()}>
            <ImageIcon size={30} className="text-primary" />
            <div><div className="text-xl">Elegir de las fotos</div><div className="text-muted">{isPreview ? PHOTOS_IN_APP : 'Una captura o una foto que ya tenés'}</div></div>
          </button>
          <button className="card flex w-full items-center gap-4 p-5 text-left" onClick={() => pdf.current?.click()}>
            <FileText size={30} className="text-primary" />
            <div><div className="text-xl">Subir un PDF</div><div className="text-muted">Facturas de UTE, Antel, compras online…</div></div>
          </button>
          {error && <p className="px-1 text-danger">{error}</p>}
          {!data.settings.ai.apiKey && !isPreview && (
            <p className="flex gap-2 px-1 pt-2 text-[15px] text-muted">
              <Sparkles size={18} className="mt-0.5 shrink-0" />
              Se lee en el teléfono. Si querés una lectura más fina, podés conectar Claude en Más → Ajustes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Review({ draft, onDone, onRetry }: { draft: InvoiceDraft; onDone: () => void; onRetry: () => void }) {
  const { data, ix, saveInvoice } = useStore();
  const { money, symbol } = useMoney();
  const toast = useToast();
  const [merchant, setMerchant] = useState(draft.merchant);
  const [date, setDate] = useState(draft.date ?? today());
  const itemsSum = draft.items.reduce((s, i) => s + i.amount, 0);
  const [totalText, setTotalText] = useState(String(draft.total ?? round2(itemsSum) ?? '').replace('.', ','));
  const [rows, setRows] = useState<Row[]>(() => draft.items.map(toRow));
  const [picking, setPicking] = useState<number | 'single' | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  // Rubro por defecto para «un solo gasto»: el más repetido entre los renglones, o el del comercio
  const guessSingle = () => {
    const counts = new Map<string, number>();
    for (const r of draft.items) if (r.rubroId) counts.set(r.rubroId, (counts.get(r.rubroId) ?? 0) + Math.abs(r.amount));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return top ?? suggestRubro('', draft.merchant, data.rubros, data.settings.learned)?.rubroId;
  };
  const [singleRubro, setSingleRubro] = useState<string | undefined>(guessSingle);
  const distinct = new Set(draft.items.map((i) => i.rubroId).filter(Boolean)).size;
  const [mode, setMode] = useState<'split' | 'single'>(draft.items.length > 1 && distinct > 1 ? 'split' : 'single');

  useEffect(() => {
    if (!draft.mime.startsWith('image/')) return;
    const url = URL.createObjectURL(draft.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [draft]);

  const total = parseAmount(totalText) ?? 0;
  const parsedRows = rows.map((r) => ({ ...r, amount: parseAmount(r.amountText) ?? 0 }));
  const sumRows = round2(parsedRows.reduce((s, r) => s + r.amount, 0));
  const missingRubro = parsedRows.some((r) => !r.rubroId && r.amount !== 0);

  const groups = useMemo(() => {
    const g = new Map<string, number>();
    for (const r of parsedRows) if (r.rubroId) g.set(r.rubroId, (g.get(r.rubroId) ?? 0) + r.amount);
    return distributeTotal(g, total);
  }, [parsedRows, total]); // eslint-disable-line react-hooks/exhaustive-deps

  const canSave = total > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && (mode === 'single' ? !!singleRubro : parsedRows.length > 0 && !missingRubro);

  const save = async () => {
    setSaving(true);
    try {
      const n = await saveInvoice({
        file: draft.file,
        fileName: draft.fileName,
        mime: draft.mime,
        merchant: merchant.trim(),
        date,
        total,
        items: parsedRows.map(({ description, amount, rubroId }) => ({ description, amount, rubroId })),
        mode,
        rubroId: singleRubro,
      });
      toast(n === 1 ? 'Factura guardada' : `Factura guardada en ${n} rubros`);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  const setRow = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-4 px-4 pb-[calc(env(safe-area-inset-bottom)+110px)]">
      <div className="flex items-center gap-3">
        {preview ? (
          <img src={preview} alt="Factura" className="h-20 w-16 rounded-xl border border-line object-cover" />
        ) : (
          <span className="flex h-20 w-16 items-center justify-center rounded-xl border border-line bg-surface"><FileText className="text-muted" /></span>
        )}
        <div className="min-w-0 flex-1 text-[15px] text-muted">
          <div className="truncate">{draft.fileName}</div>
          <div>{draft.source === 'ia' ? 'Leída con Claude' : isPreview ? 'Leída en el navegador' : 'Leída en el teléfono'} · revisá que esté bien</div>
          <button className="text-primary" onClick={onRetry}>Probar con otra</button>
        </div>
      </div>
      {draft.notice && <p className="text-[15px] text-muted">{draft.notice}</p>}

      <div className="card space-y-3 p-4">
        <div>
          <label className="label">Comercio</label>
          <input className="field" value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="¿Dónde fue?" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Fecha</label>
            <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">Total ({symbol})</label>
            <input className="field text-right tabular" inputMode="decimal" value={totalText} onChange={(e) => setTotalText(e.target.value)} />
          </div>
        </div>
      </div>

      <Segmented value={mode} onChange={setMode} options={[{ id: 'split', label: 'Separar por rubro' }, { id: 'single', label: 'Un solo gasto' }]} />

      {mode === 'single' ? (
        <div className="card p-4">
          <div className="mb-2 text-xl">¿De qué rubro es?</div>
          <RubroPicker kind="gasto" value={singleRubro} onChange={setSingleRubro} />
        </div>
      ) : (
        <>
          <div className="card divide-y divide-line px-4">
            {rows.map((r) => (
              <div key={r.key} className="space-y-2 py-3">
                <div className="flex gap-2">
                  <input className="field min-h-[40px] flex-1 px-3 text-base" value={r.description} onChange={(e) => setRow(r.key, { description: e.target.value })} />
                  <input
                    className="field min-h-[40px] w-28 px-3 text-right text-base tabular"
                    inputMode="decimal"
                    value={r.amountText}
                    onChange={(e) => setRow(r.key, { amountText: e.target.value })}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button className={r.rubroId ? 'chip' : 'chip border-danger text-danger'} onClick={() => setPicking(r.key)}>
                    {r.rubroId ? ix.rubro.get(r.rubroId)?.name : 'Elegir rubro'}
                  </button>
                  <button className="ml-auto flex min-h-tap min-w-tap items-center justify-center text-muted" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label="Quitar renglón">
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
            {!rows.length && <p className="py-4 text-muted">No encontré renglones. Agregalos o guardá un solo gasto.</p>}
            <button className="flex w-full items-center gap-2 py-3 text-primary" onClick={() => setRows((rs) => [...rs, toRow({ description: '', amount: 0 })])}>
              <Plus size={18} /> Agregar renglón
            </button>
          </div>
          {groups.size > 0 && (
            <div className="card p-4">
              <div className="text-xl">Se guarda así</div>
              {Math.abs(sumRows - total) > 0.5 && (
                <p className="text-[15px] text-muted">Los renglones suman {money(sumRows)}; la diferencia con el total (impuestos, redondeos) se reparte en proporción.</p>
              )}
              <ul className="mt-2 space-y-1">
                {[...groups.entries()].map(([rid, v]) => (
                  <li key={rid} className="flex justify-between"><span>{ix.rubro.get(rid)?.name}</span><span className="tabular">{money(v)}</span></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-bg/95 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur">
        <button className="btn-primary w-full" disabled={!canSave || saving} onClick={save}>
          {saving ? 'Guardando…' : `Guardar ${money(total)}`}
        </button>
      </div>

      {picking != null && (
        <Sheet title="Elegir rubro" onClose={() => setPicking(null)}>
          <RubroPicker
            kind="gasto"
            value={picking === 'single' ? singleRubro : rows.find((r) => r.key === picking)?.rubroId}
            onChange={(id) => {
              if (picking === 'single') setSingleRubro(id);
              else setRow(picking, { rubroId: id });
              setPicking(null);
            }}
          />
        </Sheet>
      )}
    </div>
  );
}
