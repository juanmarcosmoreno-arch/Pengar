import { CreditCard, FileText, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ConfirmSheet } from '../components/ConfirmSheet';
import { invoiceCount, invoiceTitle, InvoiceViewer } from '../components/InvoiceViewer';
import { PageHeader } from '../components/Sheet';
import { EmptyState } from '../components/Suricata';
import { Toggle } from '../components/Toggle';
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
  const statement = deleting?.kind === 'estado';
  // Para volver a subir un estado de cuenta: borrarlo con los gastos que se guardaron con él
  const [withSpends, setWithSpends] = useState(false);
  const linked = deleting ? data.movements.filter((m) => m.invoiceId === deleting.id).length : 0;
  return (
    <div>
      <PageHeader title="Facturas y estados" onBack={onBack} />
      <div className="px-4 pb-10">
        {!list.length && (
          <div className="card">
            <EmptyState pose="lista" title="Todavía no subiste nada">Usá «Factura» o «Tarjeta» en Inicio.</EmptyState>
          </div>
        )}
        {list.length > 0 && <div className="card divide-y divide-line px-4">
          {list.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 py-3">
              <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setViewing(inv)}>
                {inv.kind === 'estado' ? <CreditCard className="shrink-0 text-primary" /> : <FileText className="shrink-0 text-primary" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg">{invoiceTitle(inv)}</div>
                  <div className="text-[14px] text-muted">{[inv.date && shortDate(inv.date), invoiceCount(inv)].filter(Boolean).join(' · ')}</div>
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
        </div>}
      </div>
      {viewing && <InvoiceViewer invoice={viewing} onClose={() => setViewing(null)} />}
      {deleting && (
        <ConfirmSheet
          title={statement ? '¿Borrar el estado de cuenta?' : '¿Borrar la factura?'}
          message={withSpends && linked
            ? `Se borran el archivo guardado y ${linked === 1 ? 'el gasto que se anotó' : `los ${linked} gastos que se anotaron`} con él.`
            : `Se borra el archivo guardado. Los gastos que anotaste con ${statement ? 'él' : 'ella'} se mantienen.`}
          extra={statement && linked > 0 ? (
            <Toggle checked={withSpends} onChange={setWithSpends} label={linked === 1 ? 'Borrar también su gasto' : `Borrar también sus ${linked} gastos`} />
          ) : undefined}
          confirmLabel="Borrar"
          danger
          onConfirm={() => {
            const all = statement && withSpends && linked > 0;
            deleteInvoice(deleting.id, all);
            toast(all ? `Estado de cuenta y ${linked === 1 ? 'su gasto borrados' : `sus ${linked} gastos borrados`}` : statement ? 'Estado de cuenta borrado' : 'Factura borrada');
          }}
          onClose={() => { setDeleting(null); setWithSpends(false); }}
        />
      )}
    </div>
  );
}
