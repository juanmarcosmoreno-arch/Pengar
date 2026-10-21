/**
 * Estado de cuenta de la tarjeta (PDF, foto o planilla exportada del banco) → movimientos para revisar, con el
 * período, la tarjeta y la cotización del dólar si aparecen. Se lee todo en el teléfono.
 */
import { today } from '../domain/dates';
import { exampleStatementText } from '../domain/example';
import type { Cell } from '../domain/importSheet';
import {
  balanceCharge,
  balanceGaps,
  installmentsAtClosing,
  isSpend,
  parseStatementRows,
  parseStatementTable,
  parseStatementText,
  statementInfo,
  statementPeriod,
  type StatementRow,
  type StatementTx,
} from '../domain/statement';
import type { Data } from '../domain/types';
import { readSpreadsheet } from './files';
import { jpegName, readImageRows, readImageText, toJpeg } from './ocr';
import { readPdfRows } from './pdf';

export interface StatementDraft {
  /** El archivo para guardar (las fotos, reducidas) */
  file: Blob;
  fileName: string;
  mime: string;
  txs: StatementTx[];
  period?: { from: string; to: string };
  /** «OCA», «Visa BROU»… si aparece */
  card?: string;
  /** Límite de crédito y crédito disponible, si los trae */
  limit?: number;
  available?: number;
  /** Vencimiento (cuándo se paga), si lo trae */
  due?: string;
  /**
   * Lo que el estado de cuenta cobra (positivo) o acredita (negativo) sin que aparezca como movimiento, por moneda
   * (balanceGaps). Lo que cobra de más va también en `txs`, como un cargo para revisar (balanceCharge)
   */
  balanceGaps?: { currency: StatementTx['currency']; amount: number }[];
  /** Cotización del dólar: la del estado de cuenta o, si no trae, la última que se escribió a mano */
  usdRate?: number;
  usdRateFrom?: 'estado' | 'ultima';
  source: 'pdf' | 'planilla' | 'foto' | 'ejemplo';
}

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isSheet = (f: File) => /\.(csv|xlsx?|ods|numbers)$/i.test(f.name) || /spreadsheet|excel|csv/i.test(f.type);

const rowsText = (rows: StatementRow[]) => rows.map((r) => r.cells.map((c) => c.text).join(' ')).join('\n');
const sheetText = (rows: Cell[][]) => rows.map((r) => r.map((c) => (c == null || c instanceof Date ? '' : String(c))).join(' ')).join('\n');

/** La lectura con más compras (las columnas fallan si el PDF viene desordenado; el texto solo, si hay dos monedas) */
const better = (a: StatementTx[], b: StatementTx[]) => (b.filter(isSpend).length > a.filter(isSpend).length ? b : a);

/** Con muy pocas compras se prueba también leyendo el texto sin columnas */
const FEW = 3;

function fromRows(rows: StatementRow[]): { txs: StatementTx[]; text: string } {
  const text = rowsText(rows);
  const txs = parseStatementRows(rows);
  return { txs: txs.filter(isSpend).length < FEW ? better(txs, parseStatementText(text)) : txs, text };
}

/** `password`: la del PDF, si tiene (ver PdfPasswordError) */
export async function readStatement(file: File, data: Data, onProgress: (msg: string) => void, password?: string): Promise<StatementDraft> {
  let txs: StatementTx[] = [];
  let text = '';
  let stored: Blob = file;
  let fileName = file.name;
  let mime = file.type || 'application/octet-stream';
  let source: StatementDraft['source'];

  if (isPdf(file)) {
    source = 'pdf';
    mime = 'application/pdf';
    onProgress('Leyendo el estado de cuenta…');
    ({ txs, text } = fromRows(await readPdfRows(file, onProgress, password)));
  } else if (isSheet(file)) {
    source = 'planilla';
    onProgress('Leyendo la planilla…');
    // De todas las hojas, la que tiene más movimientos
    for (const sheet of await readSpreadsheet(file)) {
      const found = parseStatementTable(sheet.rows);
      if (found.length && better(txs, found) === found) {
        txs = found;
        text = sheetText(sheet.rows);
      }
    }
  } else {
    source = 'foto';
    // Las fotos se guardan reducidas (ocupan mucho menos y se leen igual)
    const image = await toJpeg(file);
    stored = image.blob;
    mime = 'image/jpeg';
    fileName = jpegName(file.name, 'estado-de-cuenta');
    onProgress('Leyendo la foto…');
    const rows = await readImageRows(image.blob);
    if (rows) ({ txs, text } = fromRows(rows));
    else {
      text = await readImageText(image.blob, onProgress);
      txs = parseStatementText(text);
    }
  }

  return finish({ file: stored, fileName: fileName || (source === 'pdf' ? 'estado-de-cuenta.pdf' : 'estado-de-cuenta'), mime, txs, source }, text, data);
}

/**
 * El período, la tarjeta, el límite y la cotización del encabezado. Las cuotas que vienen con la fecha de la compra
 * original pasan a la del cierre (installmentsAtClosing): los repetidos y lo que se guarda usan esa. Si el saldo del
 * cierre no da con el anterior y los movimientos, lo que cobra de más va como un cargo para revisar
 */
function finish(draft: Omit<StatementDraft, 'period' | 'card' | 'usdRate' | 'usdRateFrom' | 'limit' | 'available'>, text: string, data: Data): StatementDraft {
  const info = statementInfo(text);
  const usdRate = info.usdRate ?? data.settings.usdRate;
  const period = statementPeriod(draft.txs, info);
  const gaps = balanceGaps(draft.txs, text);
  const end = period?.to ?? draft.txs.map((t) => t.date).sort().at(-1);
  const extra = end ? gaps.filter((g) => g.amount > 0).map((g) => balanceCharge(end, g.currency, g.amount)) : [];
  return {
    ...draft,
    txs: [...installmentsAtClosing(draft.txs, period), ...extra],
    period,
    ...(gaps.length ? { balanceGaps: gaps } : {}),
    card: info.card,
    ...(info.due ? { due: info.due } : {}),
    ...(info.limit != null ? { limit: info.limit } : {}),
    ...(info.available != null ? { available: info.available } : {}),
    usdRate,
    ...(usdRate ? { usdRateFrom: info.usdRate ? 'estado' : 'ultima' } : {}),
  };
}

/** El estado de cuenta de ejemplo (para los datos de ejemplo): se guarda como texto */
export function exampleStatement(data: Data, todayISO = today()): StatementDraft {
  const text = exampleStatementText(todayISO);
  const file = new Blob([text], { type: 'text/plain' });
  return finish({ file, fileName: 'estado-de-cuenta-ejemplo.txt', mime: 'text/plain', txs: parseStatementText(text, { today: todayISO }), source: 'ejemplo' }, text, data);
}
