import { ChevronRight, CircleHelp, FileText, Layers, Repeat, Settings, Target, Users, Wallet } from 'lucide-react';
import { DemoChip } from '../components/Demo';
import { ExampleBanner } from '../components/ExampleBanner';
import { PageHeader } from '../components/Sheet';
import { useSync } from '../lib/sync';
import { useStore } from '../store/store';

export type MorePage = 'presupuesto' | 'fijos' | 'categorias' | 'metas' | 'facturas' | 'hogar' | 'ajustes' | 'ayuda';

const ITEMS: { id: MorePage; label: string; sub: string; Icon: typeof Wallet }[] = [
  { id: 'presupuesto', label: 'Presupuesto', sub: 'Cuánto gastar por mes en cada categoría', Icon: Wallet },
  { id: 'fijos', label: 'Gastos fijos', sub: 'Lo que pagás todos los meses', Icon: Repeat },
  { id: 'categorias', label: 'Categorías y rubros', sub: 'Armalos a tu gusto: nombres, íconos, colores', Icon: Layers },
  { id: 'metas', label: 'Metas', sub: 'Ahorrar para algo', Icon: Target },
  { id: 'facturas', label: 'Facturas y estados de cuenta', sub: 'Las fotos, PDF y planillas que subiste', Icon: FileText },
  { id: 'hogar', label: 'Hogar compartido', sub: 'Anotar entre varios, cada uno en su teléfono', Icon: Users },
  { id: 'ajustes', label: 'Ajustes', sub: 'Moneda, importar, respaldo, lectura con IA, modo demo', Icon: Settings },
  { id: 'ayuda', label: 'Cómo se usa', sub: 'Lo básico en un minuto', Icon: CircleHelp },
];

export function More({ onOpen }: { onOpen: (p: MorePage) => void }) {
  const { household, phase, configured } = useSync();
  const { data, demo } = useStore();
  // Después de restaurar un respaldo con la llave de un hogar: se puede volver como el mismo integrante
  const key = configured && !household && !data.settings.example ? data.settings.recovery : undefined;
  const hogar = (sub: string) => {
    if (!household) return key ? `Tenés tu llave de «${key.householdName || 'tu hogar'}»: entrá con el código` : sub;
    return phase === 'held' ? `«${household.name}»: hay algo para revisar` : `Estás en «${household.name}»`;
  };
  const subOf = (id: MorePage, sub: string) => (id === 'hogar' ? hogar(sub) : id === 'ajustes' && demo ? 'Estás en el modo demo: para salir, acá' : sub);
  return (
    <div>
      <PageHeader title="Más" right={<DemoChip className="mr-1" />} />
      <ExampleBanner className="mx-4 mb-3" />
      <div className="card mx-4 divide-y divide-line px-4">
        {ITEMS.map(({ id, label, sub, Icon }) => (
          <button key={id} className="flex w-full items-center gap-3 py-3.5 text-left" onClick={() => onOpen(id)}>
            <Icon size={24} className="shrink-0 text-primary" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="text-lg">{label}</div>
              <div className="line-clamp-2 text-[15px] text-muted">{subOf(id, sub)}</div>
            </div>
            <ChevronRight className="text-muted" size={20} />
          </button>
        ))}
      </div>
    </div>
  );
}
