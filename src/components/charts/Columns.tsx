import { useState } from 'react';
import { useMoney } from '../../lib/useMoney';
import { Tooltip } from './Tooltip';
import { barPath, useWidth } from './useWidth';

export interface Column {
  key: string;
  label: string;
  value: number;
  /** Detalle para el globito (por ejemplo, el mes completo) */
  title?: string;
}

/** Columnas por mes (gastos de los últimos meses). La última va en verde fuerte; las demás, en verde suave. */
export function Columns({ data, height = 150, highlight }: { data: Column[]; height?: number; highlight?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { money, compact } = useMoney();
  const [sel, setSel] = useState<string | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const top = 22;
  const bottom = 26;
  const plotH = height - top - bottom;
  const slot = width / Math.max(1, data.length);
  const bw = Math.min(24, slot * 0.6);
  const hi = highlight ?? data[data.length - 1]?.key;
  const selected = data.find((d) => d.key === sel);
  const selIndex = data.findIndex((d) => d.key === sel);
  return (
    <div ref={ref} className="relative select-none" onMouseLeave={() => setSel(null)}>
      <svg width={width} height={height} role="img" aria-label="Gastos por mes">
        <line x1={0} x2={width} y1={top + plotH + 0.5} y2={top + plotH + 0.5} className="stroke-line" />
        {data.map((d, i) => {
          const h = (Math.max(0, d.value) / max) * plotH;
          const x = i * slot + (slot - bw) / 2;
          const on = d.key === hi;
          return (
            <g key={d.key} onClick={() => setSel(sel === d.key ? null : d.key)} onMouseEnter={() => setSel(d.key)} className="cursor-pointer">
              <rect x={i * slot} y={0} width={slot} height={height} fill="transparent" />
              <path d={barPath(x, top + plotH - h, bw, h, 'up')} fill={on ? 'rgb(var(--primary))' : 'rgb(var(--soft))'} opacity={sel && sel !== d.key ? 0.55 : 1} />
              {on && d.value > 0 && <ValueLabel text={compact(d.value)} cx={x + bw / 2} y={top + plotH - h - 6} width={width} />}
              <text x={i * slot + slot / 2} y={height - 6} textAnchor="middle" className={`text-[13px] ${on ? 'fill-ink' : 'fill-muted'}`}>{d.label}</text>
            </g>
          );
        })}
      </svg>
      {selected && (
        <Tooltip x={selIndex * slot + slot / 2} width={width} top={-8}>
          <div className="text-muted">{selected.title ?? selected.label}</div>
          <div className="text-lg">{money(selected.value)}</div>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * El monto arriba de la columna resaltada, centrado; si no entra (la primera o la última columna en un teléfono
 * angosto), pegado al borde. El ancho se estima: unos 7,3 px por carácter a 13 px
 */
function ValueLabel({ text, cx, y, width }: { text: string; cx: number; y: number; width: number }) {
  const half = (text.length * 7.3) / 2;
  const [x, anchor]: [number, 'start' | 'middle' | 'end'] = cx + half > width - 2 ? [width - 2, 'end'] : cx - half < 2 ? [2, 'start'] : [cx, 'middle'];
  return <text x={x} y={y} textAnchor={anchor} className="fill-ink text-[13px]">{text}</text>;
}
