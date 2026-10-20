import { arc, pie } from 'd3-shape';
import { useMemo } from 'react';

export interface Slice {
  key: string;
  value: number;
  color: string;
}

/** Torta con agujero: parte del todo de un vistazo (las porciones se separan con un hilo del color del fondo) */
export function Donut({ data, size = 200, center, active, onSelect }: {
  data: Slice[];
  size?: number;
  center?: React.ReactNode;
  active?: string | null;
  onSelect?: (key: string | null) => void;
}) {
  const arcs = useMemo(() => pie<Slice>().value((d) => Math.max(0, d.value)).sort(null).padAngle(0.012)(data), [data]);
  const r = size / 2;
  const make = arc<(typeof arcs)[number]>().innerRadius(r * 0.62).outerRadius(r - 4).cornerRadius(3);
  const makeActive = arc<(typeof arcs)[number]>().innerRadius(r * 0.6).outerRadius(r).cornerRadius(3);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} role="img" aria-label="Distribución">
        {arcs.map((a) => (
          <path
            key={a.data.key}
            d={(active === a.data.key ? makeActive(a) : make(a)) ?? ''}
            fill={a.data.color}
            opacity={active && active !== a.data.key ? 0.35 : 1}
            className="cursor-pointer stroke-surface transition-opacity"
            strokeWidth={2}
            onClick={() => onSelect?.(active === a.data.key ? null : a.data.key)}
          />
        ))}
      </svg>
      {center && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>}
    </div>
  );
}
