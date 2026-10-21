import { area, curveMonotoneX, line, stack, stackOrderNone, stackOffsetNone } from 'd3-shape';
import { useMemo, useState, type PointerEvent } from 'react';
import { monthLabel } from '../../domain/dates';
import { useMoney } from '../../lib/useMoney';
import { KeyDot, Tooltip } from './Tooltip';
import { niceTicks, useWidth } from './useWidth';

export interface Series {
  key: string;
  name: string;
  color: string;
}

export interface TimeRow {
  month: string;
  values: Record<string, number>;
}

/** Ancho de una etiqueta del eje («Set 26» a 12 px), para que no se pisen */
const LABEL_W = 40;

/**
 * Evolución mes a mes. `stacked`: áreas apiladas (gastos por categoría en el tiempo).
 * Si no: líneas con un lavado suave debajo (ingresos y ahorro). Tocar o deslizar muestra el detalle del mes.
 * Si todo está en cero, en lugar del gráfico va `emptyText`.
 */
export function TimeChart({ series, rows, stacked = false, height = 220, emptyText = 'Todavía no hay datos en este período.' }: {
  series: Series[];
  rows: TimeRow[];
  stacked?: boolean;
  height?: number;
  emptyText?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { money, compact } = useMoney();
  const [hover, setHover] = useState<number | null>(null);
  const left = 48;
  const right = 10;
  const top = 10;
  const bottom = 24;
  const plotW = Math.max(10, width - left - right);
  const plotH = height - top - bottom;
  const n = rows.length;
  const x = (i: number) => left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  const { layers, max } = useMemo(() => {
    if (stacked) {
      const flat = rows.map((r) => ({ ...r.values }));
      const s = stack<Record<string, number>>().keys(series.map((s) => s.key)).order(stackOrderNone).offset(stackOffsetNone)(flat);
      const m = Math.max(1, ...s.flatMap((l) => l.map((p) => p[1])));
      return { layers: s, max: m };
    }
    const m = Math.max(1, ...rows.flatMap((r) => series.map((s) => r.values[s.key] ?? 0)));
    return { layers: null, max: m };
  }, [rows, series, stacked]);

  const ticks = niceTicks(max, 4);
  const yMax = ticks[ticks.length - 1];
  const y = (v: number) => top + plotH - (v / yMax) * plotH;

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 46))));
  // La última siempre (va alineada a la derecha); las demás, si no se pisan con la anterior ni con la última
  const anchor = (i: number) => (i === n - 1 && n > 1 ? 'end' : i === 0 && n > 1 ? 'start' : 'middle');
  const extent = (i: number): [number, number] => {
    const a = anchor(i);
    return a === 'end' ? [x(i) - LABEL_W, x(i)] : a === 'start' ? [x(i), x(i) + LABEL_W] : [x(i) - LABEL_W / 2, x(i) + LABEL_W / 2];
  };
  const labels = new Set<number>();
  if (n) {
    const lastLeft = extent(n - 1)[0];
    let prevRight = -Infinity;
    for (let i = 0; i < n - 1; i += labelEvery) {
      const [l, r] = extent(i);
      if (l < prevRight + 4 || r > lastLeft - 4) continue;
      labels.add(i);
      prevRight = r;
    }
    labels.add(n - 1);
  }
  const empty = rows.every((r) => series.every((s) => !(r.values[s.key] ?? 0)));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = n <= 1 ? 0 : Math.round(((px - left) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hoverRow = hover != null ? rows[hover] : null;
  const total = hoverRow ? series.reduce((s, k) => s + (hoverRow.values[k.key] ?? 0), 0) : 0;

  if (empty) return <div ref={ref}><p className="py-10 text-center text-muted">{emptyText}</p></div>;

  return (
    <div ref={ref} className="relative">
      <svg
        width={width}
        height={height}
        className="touch-pan-y select-none"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Evolución mensual"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={width - right} y1={y(t) + 0.5} y2={y(t) + 0.5} className="stroke-line" />
            <text x={left - 6} y={y(t) + 4} textAnchor="end" className="fill-muted text-[12px] tabular">{compact(t)}</text>
          </g>
        ))}
        {rows.map((r, i) => labels.has(i) ? (
          <text key={r.month} x={x(i)} y={height - 6} textAnchor={anchor(i)} className="fill-muted text-[12px]">{monthLabel(r.month, { short: true })}</text>
        ) : null)}

        {stacked && layers && layers.map((layer, li) => {
          const s = series[li];
          const path = area<[number, number]>()
            .x((_, i) => x(i))
            .y0((d) => y(d[0]))
            .y1((d) => y(d[1]))
            .curve(curveMonotoneX)(layer.map((p) => [p[0], p[1]]));
          return <path key={s.key} d={path ?? ''} fill={s.color} fillOpacity={0.88} className="stroke-surface" strokeWidth={1.5} />;
        })}

        {!stacked && series.map((s) => {
          const pts = rows.map((r, i) => [x(i), y(r.values[s.key] ?? 0)] as [number, number]);
          const linePath = line().curve(curveMonotoneX)(pts);
          const areaPath = area().x((d) => d[0]).y0(y(0)).y1((d) => d[1]).curve(curveMonotoneX)(pts);
          const last = pts[pts.length - 1];
          return (
            <g key={s.key}>
              <path d={areaPath ?? ''} fill={s.color} fillOpacity={0.1} />
              <path d={linePath ?? ''} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {last && <circle cx={last[0]} cy={last[1]} r={4} fill={s.color} className="stroke-surface" strokeWidth={2} />}
            </g>
          );
        })}

        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + plotH} className="stroke-muted" strokeWidth={1} />
            {!stacked && series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(rows[hover].values[s.key] ?? 0)} r={4.5} fill={s.color} className="stroke-surface" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hoverRow && (
        <Tooltip x={x(hover!)} width={width} top={-4}>
          <div className="text-muted">{monthLabel(hoverRow.month)}</div>
          {[...series].reverse().filter((s) => (hoverRow.values[s.key] ?? 0) !== 0 || !stacked).slice(0, 9).map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <KeyDot color={s.color} line={!stacked} />
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="tabular">{compact(hoverRow.values[s.key] ?? 0)}</span>
            </div>
          ))}
          {stacked && <div className="mt-1 border-t border-line pt-1">Total {money(total)}</div>}
        </Tooltip>
      )}
    </div>
  );
}

export function Legend({ series, line = false }: { series: Series[]; line?: boolean }) {
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[15px] text-muted">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <KeyDot color={s.color} line={line} />
          {s.name}
        </span>
      ))}
    </div>
  );
}
