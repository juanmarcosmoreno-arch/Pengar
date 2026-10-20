import { formatCompact, formatMoney } from '../domain/money';
import { useStore } from '../store/store';

/** Formateadores con la moneda elegida en Ajustes */
export function useMoney() {
  const c = useStore().data.settings.currency;
  return {
    money: (n: number, opts?: { sign?: boolean }) => formatMoney(n, c, opts),
    compact: (n: number) => formatCompact(n, c),
    symbol: c.symbol,
  };
}
