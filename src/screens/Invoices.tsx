import { FileText, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { InvoiceViewer } from '../components/InvoiceViewer';
import { PageHeader } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { shortDate } from '../domain/dates';
import type { Invoice } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

export function Invoices({ onBack }: { onBack: () => void }) {
  const { data, deleteInvoice } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const [viewing, setViewing] = useState<Invoice | null>(null);
  const [deleting, setDeleting] = useState<Invoice | null>(null);
  const list = [...data.invoices].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.createdAt - a.createdAt);
  return (
    <div>
      <PageHeader title="Facturas guardadas" onBack={onBack} />
      <div className="px-4 pb-10">
        {!list.length && <p className="py-10 text-center text-muted">Todavía no escaneaste facturas. Usá «Factura» en Inicio.</p>}
        <div className="card divide-y divide-line px-4">
          {list.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 py-3">
              <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setViewing(inv)}>
                <FileText className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg">{inv.merchant || inv.fileName}</div>
                  <div className="text-[14px] text-muted">{inv.date ? shortDate(inv.date) : ''} · {inv.items.length} {inv.items.length === 1 ? 'renglón' : 'renglones'}</div>
                </div>
                {inv.total != null && <span className="tabular">{money(inv.total)}</span>}
              </button>
              <button
                className="flex min-h-tap min-w-tap items-center justify-center text-muted"
                aria-label="Borrar archivo"
                onClick={() => setDeleting(inv)}
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      </div>
      {viewing && <InvoiceViewer invoice={viewing} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmSheet
          title="¿Borrar la factura?"
          message="Se borra el archivo guardado. Los gastos que anotaste con ella se mantienen."
          confirmLabel="Borrar"
          danger
          onConfirm={() => { deleteInvoice(deleting.id); toast('Factura borrada'); }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
