import type { Settings } from './types';

type Currency = Settings['currency'];

export const DEFAULT_CURRENCY: Currency = { symbol: '$', locale: 'es-UY', decimals: 0 };

const formatters = new Map<string, Intl.NumberFormat>();

function nf(locale: string, decimals: number, compact = false): Intl.NumberFormat {
  const key = `${locale}|${decimals}|${compact}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, compact
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    formatters.set(key, f);
  }
  return f;
}

/** «$ 28.450» (con signo menos si es negativo) */
export function formatMoney(n: number, c: Currency = DEFAULT_CURRENCY, opts: { sign?: boolean } = {}): string {
  const abs = nf(c.locale, c.decimals).format(Math.abs(n));
  const sign = n < 0 ? '- ' : opts.sign && n > 0 ? '+ ' : '';
  return `${sign}${c.symbol} ${abs}`;
}

/** Para ejes y etiquetas chicas: «$ 28 mil», «$ 1,2 M» */
export function formatCompact(n: number, c: Currency = DEFAULT_CURRENCY): string {
  if (Math.abs(n) < 1000) return `${c.symbol} ${Math.round(n)}`;
  return `${c.symbol} ${nf(c.locale, 0, true).format(n)}`;
}

export function formatPct(x: number, decimals = 0): string {
  return `${(x * 100).toFixed(decimals).replace('.', ',')}%`;
}

/**
 * Lee un monto escrito a mano o en una factura: «1.234,50», «1,234.50», «$ 1240», «1234.5».
 * Si hay un solo separador seguido de exactamente 3 dígitos, es de miles («1.240» → 1240).
 */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalSep: string | null = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    // «1.240» o «12.345.678» son miles; «12,5» o «1240.50» son decimales
    decimalSep = parts.length === 2 && tail.length !== 3 ? sep : null;
  }
  let normalized = s;
  if (decimalSep) {
    const thousands = decimalSep === '.' ? ',' : '.';
    normalized = s.split(thousands).join('');
    const i = normalized.lastIndexOf(decimalSep);
    normalized = normalized.slice(0, i).replace(/[.,]/g, '') + '.' + normalized.slice(i + 1);
  } else {
    normalized = s.replace(/[.,]/g, '');
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
