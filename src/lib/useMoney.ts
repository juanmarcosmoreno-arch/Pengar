import { formatCompact, formatMoney, formatNumber } from '../domain/money';
import { useStore } from '../store/store';

/** Formateadores con la moneda elegida en Ajustes */
export function useMoney() {
  const c = useStore().data.settings.currency;
  return {
    money: (n: number, opts?: { sign?: boolean }) => formatMoney(n, c, opts),
    compact: (n: number) => formatCompact(n, c),
    number: (n: number) => formatNumber(n, c),
    symbol: c.symbol,
  };
}
