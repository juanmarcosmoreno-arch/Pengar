/** Pedazos de texto con su caja (de Vision o de un PDF) → renglones, de arriba hacia abajo y de izquierda a derecha. */
export interface TextBox {
  text: string;
  /** Coordenadas normalizadas 0..1, origen arriba a la izquierda */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * Inclinación del pedazo (Δy/Δx en píxeles entre sus esquinas de arriba; positiva si baja hacia la derecha). Vision la
   * da en el iPhone (una app vieja no): es la mejor pista para enderezar la foto
   */
  slope?: number;
}

/** Las cajas agrupadas por renglón (cada renglón ordenado de izquierda a derecha) */
export function groupRows(boxes: TextBox[]): TextBox[][] {
  const items = boxes.filter((b) => b.text.trim()).map((b) => ({ ...b, cy: b.y + b.h / 2 }));
  if (!items.length) return [];
  const heights = items.map((i) => i.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 0.01;
  items.sort((a, b) => a.cy - b.cy);
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row) {
      const avg = row.reduce((s, r) => s + r.cy, 0) / row.length;
      if (Math.abs(it.cy - avg) <= medianH * 0.6) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x).map(({ text, x, y, w, h }) => ({ text, x, y, w, h })));
}

export function groupLines(boxes: TextBox[]): string[] {
  return groupRows(boxes).map((r) => r.map((i) => i.text.trim()).join(' '));
}

// --- Fotos de tickets: la foto torcida o el papel arrugado (copiado de Kvar, src/domain/ocr.ts) -----------------------
// Vision devuelve pedazos de texto con su caja; en un ticket la descripción y los números de una misma línea suelen
// venir separados. Se agrupan por altura tolerando que la foto esté torcida (y cada parte del papel, distinto).

type Item = TextBox & { cx: number; cy: number };

interface Prepared {
  items: Item[];
  medianH: number;
  /** Inclinación estimada de la foto */
  slope: number;
}

/**
 * @param aspect alto ÷ ancho de la foto. Las coordenadas de Vision son relativas a cada lado; para
 * medir la inclinación hay que llevarlas a la misma escala (un ticket es largo y angosto).
 */
function prepare(boxes: TextBox[], aspect: number): Prepared | null {
  const items = boxes
    .filter((b) => b.text.trim())
    .map((b) => ({ ...b, h: b.h * aspect, cx: b.x + b.w / 2, cy: (b.y + b.h / 2) * aspect }));
  if (!items.length) return null;

  // Inclinación de la foto: pendiente mediana entre pedazos de la misma altura aproximada
  const heights = items.map((i) => i.h).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 0.01;
  // 1) Inclinación propia de cada pedazo (esquinas de Vision). 2) Si no hay, pares de pedazos muy alineados.
  const slopes: number[] = items.filter((i) => typeof i.slope === 'number' && i.w > 0.05).map((i) => i.slope!);
  if (!slopes.length) {
    for (const a of items) {
      for (const b of items) {
        const dx = b.cx - a.cx;
        if (dx > 0.15 && Math.abs(b.cy - a.cy) < medianH * 0.5) slopes.push((b.cy - a.cy) / dx);
      }
    }
  }
  slopes.sort((a, b) => a - b);
  return { items, medianH, slope: slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0 };
}

/** Los renglones con una inclinación que puede cambiar a lo largo del ticket (`slopeAt` según la altura) */
function linesWith({ items, medianH }: Prepared, slopeAt: (y: number) => number): string[] {
  // Altura «enderezada» de cada pedazo
  const straight = items.map((i) => ({ ...i, sy: i.cy - slopeAt(i.cy) * i.cx })).sort((a, b) => a.sy - b.sy);

  const rows: (typeof straight)[] = [];
  for (const it of straight) {
    const row = rows[rows.length - 1];
    if (row) {
      const avg = row.reduce((s, r) => s + r.sy, 0) / row.length;
      if (Math.abs(it.sy - avg) <= medianH * 0.6) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  return rows.map((r) =>
    r
      .sort((a, b) => a.x - b.x)
      .map((i) => i.text.trim())
      .join(' '),
  );
}

export function groupIntoLines(boxes: TextBox[], aspect = 1): string[] {
  const p = prepare(boxes, aspect);
  return p ? linesWith(p, () => p.slope) : [];
}

/** Franjas del ticket (de arriba abajo) que pueden tener cada una su inclinación */
const BANDS = 6;
const STEP = 0.005;

/**
 * Con el papel arrugado o curvado, la inclinación que da Vision (la de cada pedazo de texto) puede errarle lo justo
 * para que cada producto quede con el precio del renglón de al lado, y el ticket se lee casi vacío. Se prueban otras
 * inclinaciones (hasta unos 17° para cada lado), primero una para toda la foto y después una por franja (el papel
 * arrugado tuerce cada parte distinto), y se queda la forma que mejor lee el ticket según `score` (la que cierra con
 * el TOTAL); a igualdad, la estimada. Si la estimada ya llega a `enough`, queda esa.
 */
export function bestGrouping(boxes: TextBox[], aspect: number, score: (lines: string[]) => number, enough = Infinity): string[] {
  const p = prepare(boxes, aspect);
  if (!p) return [];
  const seen = new Map<string, number>();
  const rate = (lines: string[]) => {
    const key = lines.join('\n');
    let s = seen.get(key);
    if (s === undefined) seen.set(key, (s = score(lines)));
    return s;
  };

  // Una inclinación para toda la foto
  let bands = Array<number>(BANDS).fill(p.slope);
  let best = linesWith(p, () => p.slope);
  let bestScore = rate(best);
  // Si ya se lee bien (cierra con el total), no hace falta probar nada más
  if (bestScore >= enough) return best;
  for (let i = -60; i <= 60; i++) {
    const lines = linesWith(p, () => i * STEP);
    const s = rate(lines);
    if (s > bestScore) {
      best = lines;
      bestScore = s;
      bands = Array<number>(BANDS).fill(i * STEP);
    }
  }

  // Una por franja, entre las alturas del primer y el último pedazo (en el medio de cada una, y pasando suave de una a otra)
  const ys = p.items.map((i) => i.cy);
  const top = Math.min(...ys);
  const height = Math.max(...ys) - top || 1;
  const slopeAt = (slopes: number[]) => (y: number) => {
    const t = Math.min(BANDS - 1, Math.max(0, ((y - top) / height) * BANDS - 0.5));
    const k = Math.floor(t);
    return k >= BANDS - 1 ? slopes[BANDS - 1] : slopes[k] + (slopes[k + 1] - slopes[k]) * (t - k);
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < BANDS; k++) {
      const base = bands[k];
      for (let d = -20; d <= 20; d++) {
        if (!d) continue;
        const trial = bands.slice();
        trial[k] = base + d * STEP;
        const lines = linesWith(p, slopeAt(trial));
        const s = rate(lines);
        if (s > bestScore) {
          best = lines;
          bestScore = s;
          bands = trial;
        }
      }
    }
  }
  return best;
}
