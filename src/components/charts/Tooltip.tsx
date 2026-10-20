import type { ReactNode } from 'react';

/** Globito de detalle sobre la gráfica; se acomoda para no salirse por los costados */
export function Tooltip({ x, width, children, top = 0 }: { x: number; width: number; children: ReactNode; top?: number }) {
  const w = 180;
  const left = Math.max(0, Math.min(width - w, x - w / 2));
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-2xl border border-line bg-surface px-3 py-2 text-[15px] leading-snug shadow-lg"
      style={{ left, top, width: w }}
    >
      {children}
    </div>
  );
}

export function KeyDot({ color, line = false }: { color: string; line?: boolean }) {
  return line
    ? <span className="inline-block h-[3px] w-3.5 shrink-0 rounded-full align-middle" style={{ background: color }} />
    : <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full align-middle" style={{ background: color }} />;
}
