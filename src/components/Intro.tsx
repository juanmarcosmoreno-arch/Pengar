import { useCallback, useEffect, useRef, useState } from 'react';
import timing from '../assets/intro/timing.json';

/**
 * La entrada de la app: el suricata sale del pozo, mira para los dos lados y se vuelve a meter. Son los 15 cuadros
 * dibujados a mano de docs/marca/suricata-intro.webp (scripts/intro.py los recorta y los alinea sobre el pozo) con
 * los tiempos de assets/intro/timing.json; cada cuadro entra con un fundido cortito sobre el anterior. Un toque la
 * saltea. Empieza recién con los cuadros ya decodificados: si tardan, no se muestra.
 */
const files = import.meta.glob<string>('../assets/intro/f*.webp', { eager: true, query: '?url', import: 'default' });
const FRAMES = Object.keys(files).sort().map((k) => files[k]);
/** [cuadro (1 a 15), segundos] */
const STEPS = timing as [number, number][];
/** Lo que dura el fundido de salida (index.css: .intro-out) */
export const INTRO_OUT_MS = 320;

/**
 * Si se muestra al abrir: no con «Reducir movimiento» del iPhone, ni en un navegador automatizado (las pruebas y las
 * capturas, salvo que la dirección lleve ?intro)
 */
export function introAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  if (navigator.webdriver && !new URLSearchParams(location.search).has('intro')) return false;
  return true;
}

/** `onLeaving`: empieza el fundido de salida (ya se puede armar la app debajo). `onDone`: terminó */
export function Intro({ onLeaving, onDone }: { onLeaving: () => void; onDone: () => void }) {
  // -1: cargando los cuadros
  const [step, setStep] = useState(-1);
  const [leaving, setLeaving] = useState(false);
  const left = useRef(false);
  const callbacks = useRef({ onLeaving, onDone });
  callbacks.current = { onLeaving, onDone };

  const leave = useCallback(() => {
    if (left.current) return;
    left.current = true;
    setLeaving(true);
    callbacks.current.onLeaving();
    setTimeout(() => callbacks.current.onDone(), INTRO_OUT_MS);
  }, []);

  useEffect(() => {
    let alive = true;
    const giveUp = setTimeout(leave, 2500);
    Promise.all(
      FRAMES.map((src) => {
        const img = new Image();
        img.src = src;
        return img.decode();
      }),
    ).then(
      () => {
        if (!alive || left.current) return;
        clearTimeout(giveUp);
        setStep(0);
      },
      () => alive && leave(),
    );
    return () => {
      alive = false;
      clearTimeout(giveUp);
    };
  }, [leave]);

  useEffect(() => {
    if (step < 0 || left.current) return;
    const t = setTimeout(() => (step + 1 < STEPS.length ? setStep(step + 1) : leave()), STEPS[step][1] * 1000);
    return () => clearTimeout(t);
  }, [step, leave]);

  const cur = STEPS[Math.max(step, 0)][0] - 1;
  const prev = step > 0 ? STEPS[step - 1][0] - 1 : -1;
  return (
    <button
      type="button"
      aria-label="Saltar la presentación"
      onClick={leave}
      className={`fixed inset-0 z-[70] flex w-full flex-col items-center justify-center bg-bg pb-[8vh] ${leaving ? 'intro-out' : ''}`}
    >
      <span className="relative block w-[min(80vw,340px)]" style={{ aspectRatio: '300 / 290' }}>
        {step >= 0 &&
          FRAMES.map((src, i) => (
            <img
              key={src}
              src={src}
              alt=""
              draggable={false}
              className={`absolute inset-0 h-full w-full ${i === cur && prev >= 0 ? 'intro-frame-in' : ''}`}
              // El cuadro nuevo entra sobre el anterior, que sigue entero debajo hasta el cambio siguiente
              style={{ opacity: i === cur || i === prev ? 1 : 0, zIndex: i === cur ? 2 : i === prev ? 1 : 0 }}
            />
          ))}
      </span>
      <span className="intro-word -mt-2 block text-6xl text-ink">Pengar</span>
    </button>
  );
}
