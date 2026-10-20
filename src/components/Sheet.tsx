import { X } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';

/** Hoja que sube desde abajo. Se cierra con la X, tocando afuera o con Escape. */
export function Sheet({ title, onClose, children, footer, tall = false }: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  tall?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true">
      <button className="absolute inset-0 bg-black/30 animate-fade" aria-label="Cerrar" onClick={onClose} />
      <div className={`relative flex max-h-[92vh] flex-col rounded-t-[28px] bg-bg shadow-2xl animate-sheet ${tall ? 'h-[92vh]' : ''}`}>
        <div className="flex items-center gap-2 px-5 pt-4 pb-2">
          <div className="min-w-0 flex-1 truncate text-2xl">{title}</div>
          <button className="-mr-2 flex min-h-tap min-w-tap items-center justify-center text-muted" onClick={onClose} aria-label="Cerrar">
            <X size={24} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="border-t border-line px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
        {!footer && <div className="pb-safe-b" />}
      </div>
    </div>
  );
}

/** Encabezado de una pantalla secundaria, con «volver» */
export function PageHeader({ title, onBack, right }: { title: ReactNode; onBack?: () => void; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-1 bg-bg/95 px-3 pt-[calc(env(safe-area-inset-top)+8px)] pb-2 backdrop-blur">
      {onBack && (
        <button className="flex min-h-tap min-w-tap items-center justify-center" onClick={onBack} aria-label="Volver">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
      )}
      <h1 className={`min-w-0 flex-1 truncate text-[28px] leading-tight ${onBack ? '' : 'pl-2'}`}>{title}</h1>
      {right}
    </header>
  );
}
