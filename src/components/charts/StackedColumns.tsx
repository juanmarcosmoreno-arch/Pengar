import { useEffect, useState } from 'react';
import { useMoney } from '../../lib/useMoney';
import { KeyDot, Tooltip } from './Tooltip';
import { barPath, useWidth } from './useWidth';

export interface StackSeries {
  key: string;
  name: string;
  color: string;
}

export interface StackColumn {
  key: string;
  /** Debajo de la columna («Nov») */
  label: string;
  /** En el globito («Noviembre 2026») */
  title: string;
  values: Record<string, number>;
}

/** Separación entre los pedazos de una columna (se ve el fondo) */
const GAP = 2;

/**
 * Columnas apiladas por mes (lo comprometido en cuotas, por tarjeta): cada serie, un pedazo, en el orden de `series`
 * de abajo para arriba. Arriba de cada columna va el total si entra (si no, solo el de la resaltada); tocar una
 * columna (o pasar el mouse) muestra el detalle, y tocar afuera lo cierra. `label`: lo que dice la gráfica entera
 * para el lector de pantalla (con lo de cada serie)
 */
export function StackedColumns({ series, data, height = 170, highlight, label }: {
  series: StackSeries[];
  data: StackColumn[];
  height?: number;
  highlight?: string;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { money, compact } = useMoney();
  const [sel, setSel] = useState<string | null>(null);
  const totals = data.map((d) => series.reduce((s, k) => s + Math.max(0, d.values[k.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const top = 22;
  const bottom = 26;
  const plotH = height - top - bottom;
  const slot = width / Math.max(1, data.length);
  const bw = Math.min(24, slot * 0.6);
  const hi = highlight ?? data[0]?.key;
  // Los totales arriba de cada columna, si entran todos (unos 6,6 px por letra a 12 px); si no, el de la resaltada
  const texts = totals.map((t) => (t > 0 ? compact(t) : ''));
  const allFit = texts.every((t) => t.length * 6.6 + 6 <= slot);
  const selIndex = data.findIndex((d) => d.key === sel);
  const selected = selIndex >= 0 ? data[selIndex] : null;
  // Tocar afuera cierra el detalle (tocar una columna siempre la elige: con el mouse, pasar ya la eligió)
  useEffect(() => {
    if (!sel) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setSel(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [sel, ref]);
  return (
    <div ref={ref} className="relative select-none" onMouseLeave={() => setSel(null)}>
      <svg width={width} height={height} role="img" aria-label={label}>
        <line x1={0} x2={width} y1={top + plotH + 0.5} y2={top + plotH + 0.5} className="stroke-line" />
        {data.map((d, i) => {
          const x = i * slot + (slot - bw) / 2;
          const on = d.key === hi;
          // De abajo para arriba; el de más arriba con la punta redondeada
          const parts = series.map((s) => ({ s, v: Math.max(0, d.values[s.key] ?? 0) })).filter((p) => p.v > 0);
          let y = top + plotH;
          const total = totals[i];
          const colH = (total / max) * plotH;
          return (
            <g key={d.key} onClick={() => setSel(d.key)} onMouseEnter={() => setSel(d.key)} className="cursor-pointer">
              <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
              {parts.map((p, k) => {
                const h = (p.v / total) * colH - (k > 0 ? GAP : 0);
                if (h <= 0.5) return null;
                y -= h + (k > 0 ? GAP : 0);
                const last = k === parts.length - 1;
                return last
                  ? <path key={p.s.key} d={barPath(x, y, bw, h, 'up')} fill={p.s.color} opacity={sel && sel !== d.key ? 0.55 : 1} />
                  : <rect key={p.s.key} x={x} y={y} width={bw} height={h} fill={p.s.color} opacity={sel && sel !== d.key ? 0.55 : 1} />;
              })}
              {texts[i] && (allFit || on) && (
                <ValueLabel text={texts[i]} cx={x + bw / 2} y={top + plotH - colH - 6} width={width} />
              )}
              <text x={i * slot + slot / 2} y={height - 6} textAnchor="middle" className={`text-[13px] ${on ? 'fill-ink' : 'fill-muted'}`}>{d.label}</text>
            </g>
          );
        })}
      </svg>
      {selected && (
        <Tooltip x={selIndex * slot + slot / 2} width={width} top={-8}>
          <div className="text-muted">{selected.title}</div>
          {[...series].reverse().filter((s) => (selected.values[s.key] ?? 0) > 0).map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <KeyDot color={s.color} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="tabular">{money(selected.values[s.key] ?? 0)}</span>
            </div>
          ))}
          <div className={series.length > 1 ? 'mt-1 border-t border-line pt-1' : ''}>Total {money(totals[selIndex])}</div>
        </Tooltip>
      )}
    </div>
  );
}

/** El total arriba de la columna, centrado; si no entra (la primera o la última en un teléfono angosto), pegado al borde */
function ValueLabel({ text, cx, y, width }: { text: string; cx: number; y: number; width: number }) {
  const half = (text.length * 6.6) / 2;
  const [x, anchor]: [number, 'start' | 'middle' | 'end'] = cx + half > width - 2 ? [width - 2, 'end'] : cx - half < 2 ? [2, 'start'] : [cx, 'middle'];
  return <text x={x} y={y} textAnchor={anchor} className="fill-ink text-[12px] tabular">{text}</text>;
}
