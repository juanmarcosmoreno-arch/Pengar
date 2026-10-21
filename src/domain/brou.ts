/**
 * Cotizaciones del BROU (www.brou.com.uy/cotizaciones): el dólar billete y el eBROU (el de la app del banco), compra y
 * venta. La página trae cada moneda con sus números «38,90000»: los dos primeros después del nombre son compra y venta.
 */
export interface BuySell {
  buy: number;
  sell: number;
}

export interface BrouRates {
  billete?: BuySell;
  ebrou?: BuySell;
}

function after(text: string, label: RegExp): BuySell | undefined {
  const m = label.exec(text);
  if (!m) return undefined;
  const nums = text.slice(m.index + m[0].length, m.index + m[0].length + 3000).match(/\d{1,3},\d{2,6}/g);
  if (!nums || nums.length < 2) return undefined;
  const [buy, sell] = nums.slice(0, 2).map((n) => Number(n.replace(',', '.')));
  return buy > 10 && sell >= buy && sell < 200 ? { buy, sell } : undefined;
}

export function parseBrou(html: string): BrouRates | null {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const out: BrouRates = {};
  const ebrou = after(text, /D[óo]lar eBROU(?! - )/);
  const billete = after(text, /D[óo]lar(?! eBROU)(?=\s)/);
  if (ebrou) out.ebrou = ebrou;
  if (billete) out.billete = billete;
  return out.ebrou || out.billete ? out : null;
}

/**
 * ¿El dólar está alto o bajo? Hoy contra el promedio de los últimos meses (BCU): más de 3 % arriba es alto (conviene
 * pasar dólares a pesos), más de 3 % abajo es bajo (conviene comprar)
 */
export function dollarLevel(rate: number, history: number[]): { average: number; pct: number; level: 'alto' | 'bajo' | 'normal' } | null {
  if (history.length < 10) return null;
  const average = history.reduce((s, x) => s + x, 0) / history.length;
  const pct = rate / average - 1;
  return { average, pct, level: pct >= 0.03 ? 'alto' : pct <= -0.03 ? 'bajo' : 'normal' };
}
