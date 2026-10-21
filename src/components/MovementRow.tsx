import { CreditCard, Paperclip } from 'lucide-react';
import { monthLabel } from '../domain/dates';
import { NBSP } from '../domain/money';
import type { Movement } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';
import { CategoryBubble } from './Icon';

export function MovementRow({ m, onClick }: { m: Movement; onClick?: () => void }) {
  const { ix } = useStore();
  const { money } = useMoney();
  const rubro = ix.rubro.get(m.rubroId);
  const cat = ix.categoryOf(m);
  const detail = m.monthly ? `Total de ${monthLabel(m.date.slice(0, 7)).toLowerCase()}` : [m.merchant, m.note].filter(Boolean).join(' · ') || cat?.name;
  return (
    <button className="flex w-full items-center gap-3 py-2.5 text-left" onClick={onClick}>
      <CategoryBubble icon={cat?.icon ?? 'tag'} color={cat?.color ?? '#8A9894'} size={44} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-lg leading-tight">{rubro?.name ?? 'Sin rubro'}</div>
        <div className="flex items-center gap-1 truncate text-[14px] text-muted">
          {m.origin === 'tarjeta' ? <CreditCard size={13} className="shrink-0" aria-label="De la tarjeta" /> : m.invoiceId && <Paperclip size={12} className="shrink-0" />}
          <span className="truncate">{detail}</span>
        </div>
      </div>
      <div className={`shrink-0 text-lg tabular ${m.kind === 'ingreso' ? 'text-ok' : ''}`}>
        {m.kind === 'ingreso' ? '+' : '-'}{NBSP}{money(Math.abs(m.amount))}
      </div>
    </button>
  );
}
