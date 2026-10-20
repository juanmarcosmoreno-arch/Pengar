import { useState } from 'react';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/Sheet';
import { Suricata } from '../components/Suricata';
import { currentMonth } from '../domain/dates';
import { parseAmount } from '../domain/money';
import { budgetAmount, incomeFor } from '../domain/stats';
import type { Budget as BudgetT, Category } from '../domain/types';
import { useMoney } from '../lib/useMoney';
import { useStore } from '../store/store';

/** Presupuesto básico: un monto fijo por mes o un porcentaje de lo que entra, por categoría */
export function Budget({ onBack }: { onBack: () => void }) {
  const { data } = useStore();
  const { money } = useMoney();
  const cats = data.categories.filter((c) => c.kind === 'gasto').sort((a, b) => a.order - b.order);
  const income = incomeFor(data, currentMonth()).amount;
  const total = cats.reduce((s, c) => s + budgetAmount(c, income), 0);
  const noSavings = cats.filter((c) => !c.savings).reduce((s, c) => s + budgetAmount(c, income), 0);
  return (
    <div>
      <PageHeader title="Presupuesto" onBack={onBack} />
      <div className="space-y-4 px-4 pb-10">
        <div className="flex items-center gap-3 px-1">
          <p className="flex-1 text-muted">Cuánto pensás gastar por mes en cada categoría. Se compara con lo real en Estadísticas → Mes.</p>
          <Suricata pose="organizando" size={90} flip />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="card px-4 py-3"><div className="text-[15px] text-muted">Gastos sin ahorro</div><div className="text-2xl">{money(noSavings)}</div></div>
          <div className="card px-4 py-3"><div className="text-[15px] text-muted">Con ahorro</div><div className="text-2xl">{money(total)}</div></div>
        </div>
        <div className="card divide-y divide-line px-4">
          {cats.map((c) => <BudgetRow key={c.id} c={c} income={income} />)}
        </div>
      </div>
    </div>
  );
}

function BudgetRow({ c, income }: { c: Category; income: number }) {
  const { upsertCategory } = useStore();
  const { money, symbol } = useMoney();
  const value = c.budget.type === 'fixed' ? String(c.budget.amount) : c.budget.type === 'percentIncome' ? String(c.budget.pct) : '';
  const [text, setText] = useState(value);
  const type = c.budget.type === 'none' ? 'fixed' : c.budget.type;
  const commit = (t: string, kind: 'fixed' | 'percentIncome' = type) => {
    const n = parseAmount(t);
    const budget: BudgetT = n == null || n <= 0 ? { type: 'none' } : kind === 'fixed' ? { type: 'fixed', amount: n } : { type: 'percentIncome', pct: n };
    upsertCategory({ ...c, budget });
  };
  return (
    <div className="flex items-center gap-3 py-3">
      <Icon name={c.icon} size={22} className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-lg">{c.name}</div>
        <button
          className="text-[14px] text-primary"
          onClick={() => commit(text, type === 'fixed' ? 'percentIncome' : 'fixed')}
        >
          {type === 'fixed' ? 'Monto fijo · cambiar a % del ingreso' : `% del ingreso (≈ ${money((income * (parseAmount(text) ?? 0)) / 100)}) · cambiar a monto`}
        </button>
      </div>
      <label className="flex items-center gap-1">
        {type === 'fixed' && <span className="text-muted">{symbol}</span>}
        <input
          className="field min-h-[40px] w-24 px-3 text-right tabular"
          inputMode="decimal"
          placeholder="—"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => commit(text)}
          aria-label={`Presupuesto de ${c.name}`}
        />
        {type === 'percentIncome' && <span className="text-muted">%</span>}
      </label>
    </div>
  );
}
