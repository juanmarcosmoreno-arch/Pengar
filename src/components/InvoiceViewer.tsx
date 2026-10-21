import { Share } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { shortDate } from '../domain/dates';
import { dayMonth } from '../domain/statementReview';
import type { Invoice } from '../domain/types';
import { loadFile } from '../lib/db';
import { NO_DOWNLOADS, saveOrShare } from '../lib/files';
import { renderPdfPages } from '../lib/pdf';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';
import { Sheet } from './Sheet';
import { Suricata } from './Suricata';
import { useToast } from './Toast';

/** «Estado de cuenta · Visa» (los estados de cuenta) o el comercio (las facturas) */
export const invoiceTitle = (inv: Invoice) =>
  inv.kind === 'estado' ? `Estado de cuenta${inv.card ? ` · ${inv.card}` : ''}` : inv.merchant || inv.fileName;

/** «23 movimientos» o «3 renglones» */
export function invoiceCount(inv: Invoice): string {
  const n = inv.items.length;
  return inv.kind === 'estado' ? `${n} ${n === 1 ? 'movimiento' : 'movimientos'}` : `${n} ${n === 1 ? 'renglón' : 'renglones'}`;
}

/**
 * Ver una factura o un estado de cuenta guardado dentro de la app, con «Compartir o guardar». Las fotos y los PDF se
 * muestran tal cual; las planillas (CSV, Excel) y el texto, como una tabla de lo que se guardó.
 */
export function InvoiceViewer({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const { ix } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const [file, setFile] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string>();
  const [status, setStatus] = useState<'cargando' | 'listo' | 'error'>('cargando');
  const [hidden, setHidden] = useState(0);
  const pagesBox = useRef<HTMLDivElement>(null);
  const isPdf = invoice.mime === 'application/pdf' || /\.pdf$/i.test(invoice.fileName);
  const isImage = !isPdf && invoice.mime.startsWith('image/');
  const noun = invoice.kind === 'estado' ? 'el estado de cuenta' : 'la factura';

  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    (async () => {
      const blob = await loadFile(invoice.id);
      if (!alive) return;
      if (!blob) throw new Error('sin archivo');
      setFile(blob);
      if (isPdf) {
        const box = pagesBox.current!;
        const { pages, total } = await renderPdfPages(blob, box.clientWidth);
        if (!alive) return;
        for (const c of pages) c.className = 'rounded-xl border border-line bg-white shadow-sm';
        box.replaceChildren(...pages);
        setHidden(total - pages.length);
      } else if (isImage) {
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      }
      setStatus('listo');
    })().catch((e) => {
      console.error(e);
      if (alive) setStatus('error');
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [invoice.id, isPdf, isImage]);

  const share = async () => {
    if (!file) return;
    try {
      if (!(await saveOrShare(file, invoice.fileName))) toast(NO_DOWNLOADS);
    } catch (e) {
      // En el iPhone, cerrar «Compartir» sin elegir nada también llega como error
      if (!/cancel/i.test(String(e))) toast('No se pudo compartir el archivo');
    }
  };

  const details = [invoice.date && shortDate(invoice.date), invoice.total != null && money(invoice.total)].filter(Boolean);
  // La planilla o el texto: lo que se guardó, sin esperar al archivo
  const table = !isPdf && !isImage;

  return (
    <Sheet
      title={invoice.kind === 'estado' ? invoiceTitle(invoice) : invoice.merchant || 'Factura'}
      onClose={onClose}
      tall
      footer={
        <button className="btn-primary w-full" disabled={!file} onClick={share}>
          <Share size={18} /> Compartir o guardar
        </button>
      }
    >
      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3 text-[16px] text-muted">
          <span className="min-w-0 truncate">{details.length ? details.join(' · ') : invoice.fileName}</span>
          {invoice.items.length > 0 && <span className="shrink-0">{invoiceCount(invoice)}</span>}
        </div>

        {status === 'cargando' && !table && (
          <div className="flex flex-col items-center gap-3 py-16 text-muted">
            <div className="h-6 w-6 animate-spin rounded-full border-[3px] border-soft border-t-primary" />
            Abriendo {noun}…
          </div>
        )}
        {status === 'error' && !table && (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Suricata pose="cara-preocupado" size={90} />
            <p className="text-xl">No se pudo abrir {noun}</p>
            <p className="text-muted">
              {file ? 'El archivo está guardado, pero no se puede mostrar acá. Probá con «Compartir o guardar».' : 'No se encontró el archivo en este teléfono.'}
            </p>
          </div>
        )}

        {isPdf ? (
          <div ref={pagesBox} className={`space-y-3 ${status === 'error' ? 'hidden' : ''}`} aria-label={`Páginas de ${noun}`} />
        ) : isImage ? (
          imageUrl && status !== 'error' && <img src={imageUrl} alt={noun} className="w-full rounded-xl border border-line" onError={() => setStatus('error')} />
        ) : (
          <div className="card divide-y divide-line px-4" aria-label="Lo que se guardó">
            {invoice.items.map((it, i) => (
              <div key={i} className="flex items-baseline gap-3 py-2">
                {it.date && <span className="w-11 shrink-0 text-[15px] text-muted tabular">{dayMonth(it.date)}</span>}
                <div className="min-w-0 flex-1">
                  <div className="truncate">{it.description || 'Sin detalle'}</div>
                  {it.rubroId && <div className="truncate text-[14px] text-muted">{ix.rubro.get(it.rubroId)?.name}</div>}
                </div>
                <span className="shrink-0 tabular">{money(it.amount)}</span>
              </div>
            ))}
            {!invoice.items.length && <p className="py-4 text-muted">No se guardaron gastos con este archivo.</p>}
          </div>
        )}
        {hidden > 0 && status === 'listo' && (
          <p className="text-center text-[15px] text-muted">Tiene {hidden} página{hidden === 1 ? '' : 's'} más. Para verla{hidden === 1 ? '' : 's'}, usá «Compartir o guardar».</p>
        )}
      </div>
    </Sheet>
  );
}
