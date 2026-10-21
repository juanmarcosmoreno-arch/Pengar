import { describe, expect, it } from 'vitest';
import { calculate } from '../calc';

describe('mini calculadora del monto', () => {
  it('suma, resta, multiplica y divide (primero × y ÷)', () => {
    expect(calculate('1200+350')).toBe(1550);
    expect(calculate('1000-250,5')).toBe(749.5);
    expect(calculate('3×450+100')).toBe(1450);
    expect(calculate('1000÷3')).toBe(333.33);
  });
  it('un operador al final no cuenta; dividir por 0 o nada escrito no da', () => {
    expect(calculate('500+')).toBe(500);
    expect(calculate('5÷0')).toBeNull();
    expect(calculate('')).toBeNull();
  });
});
