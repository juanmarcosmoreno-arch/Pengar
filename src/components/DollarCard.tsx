import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { dollarLevel, type BrouRates } from '../domain/brou';
import { addDays, today } from '../domain/dates';
import { formatRate, usd } from '../domain/fx';
import { formatPct } from '../domain/money';
import { brouRates } from '../lib/brou';
import { usdRates } from '../lib/fx';
import { useMoney } from '../lib/useMoney';
import { Suricata } from './Suricata';

export interface DollarInfo {
  brou: BrouRates | null;
  /** BCU de hoy (o el último publicado) y su promedio de los últimos 3 meses */
  bcu: number | null;
  level: ReturnType<typeof dollarLevel>;
}

/** El dólar de hoy: BROU (eBROU y billete) y BCU, y si está alto o bajo contra los últimos 3 meses */
export function useDollar(): { info: DollarInfo | null; refresh: () => void } {
  const [info, setInfo] = useState<DollarInfo | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const t = today();
    void Promise.all([brouRates(tick > 0), usdRates(addDays(t, -90), t)]).then(([brou, hist]) => {
      if (!alive) return;
      const rates = (hist ?? []).map((r) => r.rate);
      const bcu = rates.at(-1) ?? null;
      setInfo({ brou, bcu, level: bcu ? dollarLevel(bcu, rates) : null });
    });
    return () => { alive = false; };
  }, [tick]);
  return { info, refresh: () => setTick((n) => n + 1) };
}

export function DollarCard({ usdSaved, compact = false }: { usdSaved: number; compact?: boolean }) {
  const { info, refresh } = useDollar();
  const { money } = useMoney();
  if (!info) return null;
  const e = info.brou?.ebrou;
  const b = info.brou?.billete;
  const lv = info.level;
  if (compact && (!lv || lv.level === 'normal' || usdSaved <= 0)) return null;
  const sellRate = e?.buy ?? b?.buy ?? info.bcu;
  const advice = lv && lv.level !== 'normal'
    ? lv.level === 'alto'
      ? `El dólar está alto: ${formatPct(lv.pct)} arriba del promedio de 3 meses (${formatRate(lv.average)}). Si necesitás pesos, es buen momento para pasar dólares.`
      : `El dólar está bajo: ${formatPct(-lv.pct)} abajo del promedio de 3 meses (${formatRate(lv.average)}). Si querés ahorrar en dólares, es buen momento para comprar.`
    : lv ? 'El dólar está en su precio de los últimos meses.' : '';
  return (
    <section className={`card relative overflow-hidden p-4 ${lv?.level === 'alto' ? 'border-ok/50' : lv?.level === 'bajo' ? 'border-primary/50' : ''}`}>
      <div className="flex items-baseline justify-between">
        <h2 className="section-title">Dólar hoy</h2>
        {!compact && <button className="-my-2 flex min-h-tap min-w-tap items-center justify-center text-muted" onClick={refresh} aria-label="Actualizar cotizaciones"><RefreshCw size={18} /></button>}
      </div>
      {!compact && (
        <div className="mt-1 space-y-0.5 text-[16px] tabular">
          {e && <div>eBROU: compra {formatRate(e.buy)} · venta {formatRate(e.sell)}</div>}
          {b && <div className="text-muted">BROU billete: compra {formatRate(b.buy)} · venta {formatRate(b.sell)}</div>}
          {info.bcu && <div className="text-muted">BCU: {formatRate(info.bcu)}</div>}
          {!info.brou && <div className="text-[14px] text-muted">La cotización del BROU se ve en el iPhone.</div>}
        </div>
      )}
      {advice && <p className="mt-2 pr-24 text-[15px] leading-snug">{advice}</p>}
      {usdSaved > 0 && sellRate && (
        <p className="mt-1 pr-24 text-[15px] text-muted">Tus {usd(usdSaved)} hoy son unos {money(usdSaved * sellRate)}{e ? ' en eBROU' : ''}.</p>
      )}
      <Suricata pose="asomado" size={54} className="absolute -bottom-1 right-1" />
    </section>
  );
}
