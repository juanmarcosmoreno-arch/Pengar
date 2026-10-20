import { ChartNoAxesColumn, Ellipsis, FileText, House } from 'lucide-react';

export type Tab = 'inicio' | 'movimientos' | 'estadisticas' | 'mas';

const TABS: { id: Tab; label: string; Icon: typeof House }[] = [
  { id: 'inicio', label: 'Inicio', Icon: House },
  { id: 'movimientos', label: 'Movimientos', Icon: FileText },
  { id: 'estadisticas', label: 'Estadísticas', Icon: ChartNoAxesColumn },
  { id: 'mas', label: 'Más', Icon: Ellipsis },
];

export function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-safe-b backdrop-blur">
      <div className="mx-auto flex max-w-xl">
        {TABS.map(({ id, label, Icon }) => {
          const on = tab === id;
          return (
            <button
              key={id}
              className={`flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[13px] ${on ? 'text-primary' : 'text-muted'}`}
              onClick={() => onChange(id)}
              aria-current={on ? 'page' : undefined}
            >
              <Icon size={24} strokeWidth={on ? 2.2 : 1.6} />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

