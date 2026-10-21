import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { guessIcon } from '../importSheet';
import { ICON_CHOICES } from '../template';

describe('íconos de categorías', () => {
  it('cada dibujo que se puede elegir tiene su imagen', () => {
    const missing = ICON_CHOICES.filter((n) => n.startsWith('m:'))
      .filter((n) => !existsSync(new URL(`../../assets/suricata/cat/${n.slice(2)}.webp`, import.meta.url)));
    expect(missing).toEqual([]);
  });

  it('no repite dibujos', () => {
    expect(new Set(ICON_CHOICES).size).toBe(ICON_CHOICES.length);
  });

  it('el diezmo y las ofrendas toman el dibujo del diezmo', () => {
    expect(guessIcon('Diezmos / Ofrendas')).toBe('m:diezmo');
    expect(guessIcon('Ofrendas')).toBe('m:diezmo');
    expect(guessIcon('Donaciones')).toBe('m:donaciones');
  });

  it('las reglas nuevas no les sacan el dibujo a las de antes', () => {
    expect(guessIcon('Alimentación')).toBe('m:super');
    expect(guessIcon('Vivienda / alquiler')).toBe('m:vivienda');
    expect(guessIcon('Educación / cursos')).toBe('m:educacion');
    expect(guessIcon('Viajes')).toBe('m:viajes');
    expect(guessIcon('Vacaciones')).toBe('m:vacaciones');
    expect(guessIcon('Cuidado personal')).toBe('m:cuidado-personal');
  });
});
