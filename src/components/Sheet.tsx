import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Hoja que sube desde abajo. Se cierra con la X, tocando afuera o con Escape (solo la de más arriba si hay dos). */
export function Sheet({ title, onClose, children, footer, tall = false }: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  tall?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const open = document.querySelectorAll('[role=dialog]');
      if (e.key === 'Escape' && open[open.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    // !m-0: dentro de un space-y-* el margen de arriba dejaba una franja sin tapar
    <div ref={ref} className="fixed inset-0 z-40 !m-0 flex flex-col justify-end" role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined}>
      <button className="absolute inset-0 bg-black/30 animate-fade" aria-label="Cerrar" onClick={onClose} />
      <div className={`relative flex max-h-[92%] flex-col rounded-t-[28px] bg-bg shadow-2xl animate-sheet ${tall ? 'h-[92%]' : ''}`}>
        <div className="flex items-center gap-2 px-5 pt-4 pb-2">
          <div id={titleId} className="min-w-0 flex-1 truncate text-2xl">{title}</div>
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

/** Encabezado de una pantalla secundaria, con «volver». `titleId`: para nombrar la pantalla entera (aria-labelledby) */
export function PageHeader({ title, onBack, right, titleId }: { title: ReactNode; onBack?: () => void; right?: ReactNode; titleId?: string }) {
  return (
    <header className="sticky top-0 z-10 flex items-center gap-1 bg-bg/95 px-3 pt-[calc(env(safe-area-inset-top)+8px)] pb-2 backdrop-blur">
      {onBack && (
        <button className="flex min-h-tap min-w-tap items-center justify-center" onClick={onBack} aria-label="Volver">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
      )}
      <h1 id={titleId} className={`min-w-0 flex-1 truncate text-[28px] leading-tight ${onBack ? '' : 'pl-2'}`}>{title}</h1>
      {right}
    </header>
  );
}
