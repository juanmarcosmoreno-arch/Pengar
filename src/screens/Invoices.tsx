import { FileText, Trash2 } from 'lucide-react';
import { PageHeader } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { shortDate } from '../domain/dates';
import { loadFile } from '../lib/db';
import { openFile } from '../lib/files';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

export function Invoices({ onBack }: { onBack: () => void }) {
  const { data, deleteInvoice } = useStore();
  const { money } = useMoney();
  const toast = useToast();
  const list = [...data.invoices].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.createdAt - a.createdAt);
  return (
    <div>
      <PageHeader title="Facturas guardadas" onBack={onBack} />
      <div className="px-4 pb-10">
        {!list.length && <p className="py-10 text-center text-muted">Todavía no escaneaste facturas. Usá «Factura» en Inicio.</p>}
        <div className="card divide-y divide-line px-4">
          {list.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 py-3">
              <button
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                onClick={async () => {
                  const blob = await loadFile(inv.id);
                  if (blob) await openFile(blob, inv.fileName);
                  else toast('No se encontró el archivo');
                }}
              >
                <FileText className="shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-lg">{inv.merchant || inv.fileName}</div>
                  <div className="text-[14px] text-muted">{inv.date ? shortDate(inv.date) : ''} · {inv.items.length} renglones</div>
                </div>
                {inv.total != null && <span className="tabular">{money(inv.total)}</span>}
              </button>
              <button
                className="flex min-h-tap min-w-tap items-center justify-center text-muted"
                aria-label="Borrar archivo"
                onClick={() => { if (confirm('¿Borrar el archivo de esta factura? Los gastos anotados se mantienen.')) deleteInvoice(inv.id); }}
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
