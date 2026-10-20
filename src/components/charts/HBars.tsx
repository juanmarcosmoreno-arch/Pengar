import { useMoney } from '../../lib/useMoney';
import { barPath, useWidth } from './useWidth';

export interface HBar {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Texto chico debajo del nombre (por ejemplo, la categoría de un rubro) */
  sub?: string;
}

/** Barras horizontales ordenadas, con el valor en la punta */
export function HBars({ data, labelWidth = 120, format, onSelect }: {
  data: HBar[];
  labelWidth?: number;
  format?: (n: number) => string;
  onSelect?: (key: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { compact } = useMoney();
  const fmt = format ?? compact;
  const max = Math.max(1, ...data.map((d) => d.value));
  const valueW = 64;
  const plotW = Math.max(40, width - labelWidth - valueW);
  const row = 34;
  const bh = 14;
  return (
    <div ref={ref}>
      <svg width={width} height={data.length * row} role="img" aria-label="Barras">
        {data.map((d, i) => {
          const w = (Math.max(0, d.value) / max) * plotW;
          const y = i * row;
          return (
            <g key={d.key} onClick={() => onSelect?.(d.key)} className={onSelect ? 'cursor-pointer' : ''}>
              <title>{`${d.label}: ${fmt(d.value)}`}</title>
              <rect x={0} y={y} width={width} height={row} fill="transparent" />
              <foreignObject x={0} y={y} width={labelWidth - 8} height={row}>
                <div className="flex h-full flex-col justify-center leading-tight">
                  <div className="truncate text-[15px] text-ink">{d.label}</div>
                  {d.sub && <div className="truncate text-[12px] text-muted">{d.sub}</div>}
                </div>
              </foreignObject>
              <line x1={labelWidth} x2={labelWidth} y1={y + 6} y2={y + row - 6} className="stroke-line" />
              <path d={barPath(labelWidth, y + (row - bh) / 2, w, bh, 'right')} fill={d.color} />
              <text x={labelWidth + w + 6} y={y + row / 2 + 5} className="fill-ink text-[14px] tabular">{fmt(d.value)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
