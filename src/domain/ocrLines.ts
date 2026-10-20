/** Pedazos de texto con su caja (de Vision o de un PDF) → renglones, de arriba hacia abajo y de izquierda a derecha. */
export interface TextBox {
  text: string;
  /** Coordenadas normalizadas 0..1, origen arriba a la izquierda */
  x: number;
  y: number;
  w: number;
  h: number;
}

export function groupLines(boxes: TextBox[]): string[] {
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
  return rows.map((r) => r.sort((a, b) => a.x - b.x).map((i) => i.text.trim()).join(' '));
}
