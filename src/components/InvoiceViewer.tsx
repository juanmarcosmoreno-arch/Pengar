import { Share } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { shortDate } from '../domain/dates';
import { dayMonth } from '../domain/statementReview';
import type { Invoice } from '../domain/types';
import { NO_DOWNLOADS, saveOrShare } from '../lib/files';
import { jpegName } from '../lib/ocr';
import { PdfPasswordError, renderPdfPages } from '../lib/pdf';
import { isPreview } from '../lib/platform';
import { RemoteError } from '../lib/remote';
import { loadInvoiceFile, useSync } from '../lib/sync';
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
  const [status, setStatus] = useState<'cargando' | 'listo' | 'error' | 'clave'>('cargando');
  // En un hogar compartido, el archivo de otro se baja la primera vez: sin conexión no se puede
  const [offline, setOffline] = useState(false);
  const [hidden, setHidden] = useState(0);
  // «Probar de nuevo» (en un hogar, el archivo puede no haber llegado todavía)
  const [tries, setTries] = useState(0);
  const sync = useSync();
  const inHousehold = !!sync.household && sync.phase !== 'removed';
  const pagesBox = useRef<HTMLDivElement>(null);
  const isPdf = invoice.mime === 'application/pdf' || /\.pdf$/i.test(invoice.fileName);
  const isImage = !isPdf && invoice.mime.startsWith('image/');
  const noun = invoice.kind === 'estado' ? 'el estado de cuenta' : 'la factura';

  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    setStatus('cargando');
    (async () => {
      const blob = await loadInvoiceFile(invoice.id);
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
      if (!alive) return;
      setOffline(e instanceof RemoteError && e.kind === 'offline');
      setStatus(e instanceof PdfPasswordError ? 'clave' : 'error');
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [invoice.id, isPdf, isImage, tries]);

  // Las fotos se guardan como JPEG: si el nombre es otro («IMG_1234.PNG», de antes), se comparte como .jpg
  const shareName = invoice.mime === 'image/jpeg' && !/\.jpe?g$/i.test(invoice.fileName) ? jpegName(invoice.fileName, 'factura') : invoice.fileName;
  const share = async () => {
    if (!file) return;
    try {
      if (!(await saveOrShare(file, shareName))) toast(NO_DOWNLOADS);
    } catch (e) {
      console.error(e);
      toast('No se pudo compartir el archivo');
    }
  };
  // En la vista previa no se descarga nada: el visor no manda a «Compartir o guardar»
  const where = isPreview ? 'en este navegador' : 'en este teléfono';

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
        {(status === 'error' || status === 'clave') && !table && (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Suricata pose="cara-preocupado" size={90} />
            <p className="text-xl">{status === 'clave' ? 'Este PDF tiene contraseña' : `No se pudo abrir ${noun}`}</p>
            <p className="text-muted">
              {offline
                ? 'Está en el hogar compartido, pero sin conexión no se puede bajar. Probá de nuevo con conexión.'
                : !file && inHousehold
                ? 'Todavía no está en el hogar: puede que el teléfono donde se anotó no lo haya subido. Probá de nuevo en un rato.'
                : !file
                ? `No se encontró el archivo ${where}.`
                : isPreview
                  ? 'El archivo está guardado, pero no se puede mostrar acá. En la app de iPhone lo podés compartir o guardar.'
                  : status === 'clave'
                    ? 'Para verlo, abrilo con «Compartir o guardar» (te pide la contraseña).'
                    : 'El archivo está guardado, pero no se puede mostrar acá. Probá con «Compartir o guardar».'}
            </p>
            {!file && (offline || inHousehold) && (
              <button className="btn-outline mt-2" onClick={() => setTries((n) => n + 1)}>Probar de nuevo</button>
            )}
          </div>
        )}

        {isPdf ? (
          <div
            ref={pagesBox}
            className={`space-y-3 ${status === 'error' || status === 'clave' ? 'hidden' : ''}`}
            aria-label={invoice.kind === 'estado' ? 'Páginas del estado de cuenta' : 'Páginas de la factura'}
          />
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
          <p className="text-center text-[15px] text-muted">
            Tiene {hidden} página{hidden === 1 ? '' : 's'} más.{' '}
            {isPreview ? `En la app de iPhone se ve${hidden === 1 ? '' : 'n'} con «Compartir o guardar».` : `Para verla${hidden === 1 ? '' : 's'}, usá «Compartir o guardar».`}
          </p>
        )}
      </div>
    </Sheet>
  );
}
