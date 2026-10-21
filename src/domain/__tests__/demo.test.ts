import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { backupDue } from '../autoBackup';
import { dataKey, demoData, demoOutdated, demoTicketLines, fileIdOf, fileKey, isDemoData, ticketAmount, ticketPdf, TICKET_MERCHANT } from '../demo';
import { exampleStatementText } from '../example';
import { importMonthlySheet, type Cell } from '../importSheet';
import { commitments, nextMonthOutlook } from '../installments';
import { pendingRecurring } from '../recurring';
import { pendingReport } from '../report';
import { isSpend, parseStatementText } from '../statement';
import { knownRubro, spendRubros } from '../statementReview';
import { buildIndex, kpis } from '../stats';
import { syncable } from '../sync';
import { normalizeData } from '../template';

const sheet = importMonthlySheet(JSON.parse(readFileSync('public/ejemplo.json', 'utf8')) as Cell[][]);
const TODAY = '2026-10-21';

describe('modo demo: dónde se guarda', () => {
  it('los datos y los archivos de cada juego van en claves distintas', () => {
    expect(dataKey('real')).toBe('data');
    expect(dataKey('demo')).toBe('data-demo');
    expect(fileKey('real', 'f1')).toBe('file:f1');
    expect(fileKey('demo', 'f1')).toBe('demo-file:f1');
    // Ninguna clave de un juego es del otro (así borrar los archivos de uno nunca toca los del otro)
    expect(fileIdOf('real', fileKey('real', 'f1'))).toBe('f1');
    expect(fileIdOf('demo', fileKey('demo', 'f1'))).toBe('f1');
    expect(fileIdOf('real', fileKey('demo', 'f1'))).toBeNull();
    expect(fileIdOf('demo', fileKey('real', 'f1'))).toBeNull();
    expect(fileIdOf('real', 'data')).toBeNull();
    expect(fileIdOf('demo', 'demo-file:')).toBeNull();
  });
});

describe('modo demo: los datos inventados', () => {
  const { data, files } = demoData(sheet, TODAY);
  const ix = buildIndex(data);
  const name = (id: string) => ix.rubro.get(id)?.name;

  it('son los del ejemplo con su propio indicador (no el de la bienvenida) y no se sincronizan ni se respaldan', () => {
    expect(data.settings).toMatchObject({ name: 'Ana', onboarded: true, demo: true });
    expect(data.settings.example).toBeUndefined();
    expect(data.datasetId).toBeTruthy();
    expect(syncable(data)).toBe(false);
    expect(backupDue({ enabled: true }, data, Date.now(), true)).toEqual({ due: false, why: 'example' });
    // normalizeData conserva el indicador
    expect(normalizeData(JSON.parse(JSON.stringify(data))).settings.demo).toBe(true);
    // Este mes entró el sueldo y queda plata
    const k = kpis(data, ix, { from: '2026-10', to: '2026-10', includeSavings: false });
    expect(k.income).toBeGreaterThan(0);
    expect(k.balance).toBeGreaterThan(0);
    expect(data.goals.map((g) => g.name)).toEqual(['Vacaciones', 'Fondo de emergencia']);
  });

  it('tiene gastos fijos para anotar este mes, otros más adelante y el resumen del mes pasado sin abrir', () => {
    const pending = pendingRecurring(data, '2026-10', TODAY);
    expect(pending.filter((r) => r.due).map((r) => name(r.rubroId))).toEqual(['Antel', 'Netflix', 'Emergencia móvil']);
    expect(pending.filter((r) => !r.due).map((r) => name(r.rubroId))).toEqual(['OSE', 'Club', 'Celular']);
    // Los ya anotados este mes no se piden
    expect(data.recurring.map((r) => name(r.rubroId))).toEqual(expect.arrayContaining(['Alquiler', 'UTE', 'Entrada']));
    expect(pendingReport(data, TODAY)).toBe('2026-09');
    // El primer día del mes también hay para anotar
    const first = demoData(sheet, '2026-11-01').data;
    expect(pendingRecurring(first, '2026-11', '2026-11-01').filter((r) => r.due).length).toBe(3);
    // El 27, los de más adelante caen el 28 (todavía no)
    const late = demoData(sheet, '2026-10-27').data;
    const lateIx = buildIndex(late);
    const soon = pendingRecurring(late, '2026-10', '2026-10-27').filter((r) => !r.due);
    expect(soon.map((r) => lateIx.rubro.get(r.rubroId)?.name).sort()).toEqual(['Celular', 'Club', 'OSE']);
    expect(soon.every((r) => r.day === 28)).toBe(true);
    // Del 28 a fin de mes ya no queda día para ellos (los fijos llegan al 28): quedan anotados, no se piden como vencidos
    for (const d of ['2026-10-28', '2026-10-31', '2026-11-30', '2027-02-28']) {
      const last = demoData(sheet, d).data;
      const lix = buildIndex(last);
      const pending = pendingRecurring(last, d.slice(0, 7), d);
      expect(pending.filter((r) => r.due).map((r) => lix.rubro.get(r.rubroId)?.name)).toEqual(['Antel', 'Netflix', 'Emergencia móvil']);
      expect(pending.filter((r) => !r.due)).toEqual([]);
      const later = last.recurring.filter((r) => ['OSE', 'Club', 'Celular'].includes(lix.rubro.get(r.rubroId)?.name ?? ''));
      expect(later.every((r) => r.doneThrough === d.slice(0, 7) && last.movements.some((m) => m.id === `m-${r.id}-${d.slice(0, 7)}` && m.amount === r.amount && m.date <= d))).toBe(true);
    }
  });

  it('no trae diezmo ni ofrendas', () => {
    expect(data.categories.some((c) => c.budget.type === 'percentIncome' || /diezmo|ofrenda/i.test(c.name))).toBe(false);
    expect(data.rubros.some((r) => /diezmo|ofrenda/i.test(r.name))).toBe(false);
  });

  it('trae una factura del súper separada por rubro, con su ticket en PDF', () => {
    const facturas = data.invoices.filter((i) => i.kind !== 'estado');
    expect(facturas).toHaveLength(1);
    const inv = facturas[0];
    expect(inv).toMatchObject({ merchant: TICKET_MERCHANT, mime: 'application/pdf', total: 1432 });
    const ms = data.movements.filter((m) => m.invoiceId === inv.id);
    expect(ms.map((m) => [name(m.rubroId), m.amount])).toEqual([['Supermercado', 1016], ['Limpieza', 416]]);
    expect(ms.every((m) => m.origin === 'factura' && m.date === inv.date && m.date <= TODAY)).toBe(true);
    expect(files).toEqual([{ id: inv.id, mime: 'application/pdf', bytes: expect.any(Uint8Array) }]);
    expect(new TextDecoder('latin1').decode(files[0].bytes.slice(0, 8))).toBe('%PDF-1.4');
  });

  it('el estado de cuenta de ejemplo sale casi todo conocido: solo dos comercios nuevos', () => {
    const rubros = spendRubros(data.rubros, data.categories);
    const txs = parseStatementText(exampleStatementText(TODAY)).filter(isSpend);
    const unknown = new Set(txs.filter((tx) => !knownRubro(tx, rubros, data.settings.learned)).map((tx) => tx.merchant));
    expect([...unknown]).toEqual(['Movie Center', 'Ferreteria el Tornillo']);
    // Lo aprendido de la factura del súper (el comercio va al rubro con más renglones)
    expect(Object.values(data.settings.learned).length).toBeGreaterThan(9);
  });

  it('trae estados de cuenta de tres tarjetas con cuotas por delante (sin gastos: esos meses están en la planilla)', () => {
    const c = commitments(data, { today: TODAY });
    expect(c.cards.map((x) => [x.card, x.stale, x.plans.length > 0])).toEqual([['Itaú', false, true], ['OCA', false, true], ['Scotiabank', true, true]]);
    expect(data.movements.some((m) => data.invoices.some((i) => i.kind === 'estado' && i.id === m.invoiceId))).toBe(false);
    const o = nextMonthOutlook(data, { today: TODAY });
    expect(o.installments).toBeGreaterThan(0);
    expect(o.income?.from).toBe('fijos');
    expect(o.margin).toBeGreaterThan(0);
    expect(o.staleCards).toEqual(['Scotiabank']);
  });

  it('se vuelve a armar si es de un mes que ya pasó', () => {
    expect(demoOutdated(data, TODAY)).toBe(false);
    expect(demoOutdated(data, '2026-11-02')).toBe(true);
    // Lo que no es del demo (un respaldo de verdad que se coló) también: si no, se mostraría cada vez
    expect(demoOutdated({ ...data, settings: { ...data.settings, demo: undefined } }, TODAY)).toBe(true);
    expect(demoOutdated({ ...data, settings: { ...data.settings, onboarded: false } }, TODAY)).toBe(true);
    expect(demoOutdated({ ...data, settings: { ...data.settings, example: true } }, TODAY)).toBe(true);
    expect(isDemoData(data)).toBe(true);
    expect(isDemoData({ settings: { ...data.settings, demo: undefined } })).toBe(false);
    expect(demoOutdated({ ...data, movements: data.movements.filter((m) => m.monthly) }, TODAY)).toBe(true);
  });
});

describe('ticket en PDF', () => {
  const text = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

  it('es un PDF bien armado: cada objeto donde dice la tabla', () => {
    const pdf = text(ticketPdf(demoTicketLines('2026-10-12')));
    expect(pdf.startsWith('%PDF-1.4\n')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    const startxref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // El largo del contenido es el de verdad
    const len = Number(/\/Length (\d+)/.exec(pdf)![1]);
    const start = pdf.indexOf('stream\n') + 'stream\n'.length;
    expect(pdf.slice(start + len, start + len + '\nendstream'.length)).toBe('\nendstream');
    expect(pdf).toContain('(S\xdaPER EL TR\xc9BOL)');
    expect(pdf).toContain('Fecha: 12/10/2026');
  });

  it('escapa los paréntesis y lo que no entra en Latin-1', () => {
    const pdf = text(ticketPdf([{ text: 'Ticket (demo) \\ ok… 🙂' }]));
    expect(pdf).toContain('(Ticket \\(demo\\) \\\\ ok? ??) Tj');
  });

  it('montos como en el ticket', () => {
    expect(ticketAmount(1432)).toBe('1.432,00');
    expect(ticketAmount(98)).toBe('98,00');
    expect(ticketAmount(1234567.5)).toBe('1.234.567,50');
  });

  it('pdf.js lo lee', async () => {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await lib.getDocument({ data: ticketPdf(demoTicketLines('2026-10-12')), useWorkerFetch: false }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    // pdf.js corta en palabras: se juntan con un espacio
    const all = content.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ');
    expect(all).toContain('SÚPER EL TRÉBOL');
    expect(all).toContain('TOTAL $ 1.432,00');
    expect(all).toContain('Papel higiénico x4 189,00');
  });
});
