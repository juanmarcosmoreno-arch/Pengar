/**
 * La cuenta de la mini calculadora del monto: números con coma decimal y + − × ÷ (primero × y ÷). Un operador al final
 * se ignora. null si no se puede hacer (dividir por 0, nada escrito)
 */
export function calculate(expr: string): number | null {
  const tokens = expr.replace(/\s/g, '').match(/\d+(?:,\d*)?|,\d+|[+\-×÷]/g);
  if (!tokens?.length) return null;
  while (tokens.length && /[+\-×÷]/.test(tokens[tokens.length - 1])) tokens.pop();
  const nums: number[] = [];
  const ops: string[] = [];
  let expectNum = true;
  let sign = 1;
  for (const t of tokens) {
    if (/[+\-×÷]/.test(t)) {
      if (expectNum) {
        if (t === '-') sign = -sign;
        continue;
      }
      ops.push(t);
      expectNum = true;
    } else {
      nums.push(sign * Number(t.replace(',', '.')));
      sign = 1;
      expectNum = false;
    }
  }
  if (!nums.length) return null;
  // Primero × y ÷
  const n2 = [nums[0]];
  const o2: string[] = [];
  for (let i = 0; i < ops.length; i++) {
    const b = nums[i + 1];
    if (ops[i] === '×') n2[n2.length - 1] *= b;
    else if (ops[i] === '÷') {
      if (b === 0) return null;
      n2[n2.length - 1] /= b;
    } else {
      o2.push(ops[i]);
      n2.push(b);
    }
  }
  let r = n2[0];
  o2.forEach((o, i) => { r = o === '+' ? r + n2[i + 1] : r - n2[i + 1]; });
  return Number.isFinite(r) ? Math.round(r * 100) / 100 : null;
}

/** «1234,5»: para el campo del monto (coma decimal, sin miles) */
export const calcText = (n: number) => String(n).replace('.', ',');
