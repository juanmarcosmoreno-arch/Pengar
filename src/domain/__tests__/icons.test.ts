import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { guessIcon } from '../importSheet';
import { ART_SAME, ICON_CHOICES } from '../template';

describe('íconos de categorías', () => {
  it('cada dibujo que se puede elegir tiene su imagen', () => {
    const missing = ICON_CHOICES.filter((n) => n.startsWith('m:'))
      .filter((n) => !existsSync(new URL(`../../assets/suricata/cat/${n.slice(2)}.webp`, import.meta.url)));
    expect(missing).toEqual([]);
  });

  it('no repite dibujos', () => {
    expect(new Set(ICON_CHOICES).size).toBe(ICON_CHOICES.length);
  });

  it('las versiones casi iguales no se ofrecen y cuentan como una de la lista', () => {
    for (const [hidden, shown] of Object.entries(ART_SAME)) {
      expect(ICON_CHOICES).not.toContain(hidden);
      expect(ICON_CHOICES).toContain(shown);
    }
  });

  it('el ícono que se adivina por el nombre está en la lista', () => {
    for (const name of ['Alimentación', 'Fijos', 'Transporte', 'Salud', 'Telefonía', 'Compras online', 'Hogar', 'Salidas', 'Libros', 'Inversiones', 'Ingresos', 'Imprevistos', 'Otros', 'Calefacción', 'Nada que ver']) {
      expect(ICON_CHOICES).toContain(guessIcon(name));
    }
  });

  it('el diezmo y las ofrendas toman el dibujo del diezmo', () => {
    expect(guessIcon('Diezmos / Ofrendas')).toBe('m:diezmo');
    expect(guessIcon('Ofrendas')).toBe('m:diezmo');
    expect(guessIcon('Donaciones')).toBe('m:donaciones');
  });

  it('las reglas nuevas no les sacan el dibujo a las de antes', () => {
    expect(guessIcon('Alimentación')).toBe('m:super-3');
    expect(guessIcon('Vivienda / alquiler')).toBe('m:vivienda-3');
    expect(guessIcon('Educación / cursos')).toBe('m:educacion-3');
    expect(guessIcon('Viajes')).toBe('m:viajes-3');
    expect(guessIcon('Vacaciones')).toBe('m:vacaciones');
    expect(guessIcon('Cuidado personal')).toBe('m:cuidado-personal');
  });
});
