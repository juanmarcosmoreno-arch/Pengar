import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { itemKey } from '../../domain/classify';
import type { TextBox } from '../../domain/ocrLines';
import { emptyData, templateData } from '../../domain/template';
import type { Data } from '../../domain/types';

// El plugin nativo (Vision y el portal del súper), la plataforma, la IA y el achicado de la foto (usa el DOM), simulados
const mocks = vi.hoisted(() => ({
  ocr: { recognize: vi.fn(), fetchCfe: vi.fn() },
  platform: { isNative: true, isPreview: false },
  appleStatus: vi.fn(),
  apple: vi.fn(),
  claudeRead: vi.fn(),
  claudeClassify: vi.fn(),
  tesseract: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => (name === 'PengarOCR' ? mocks.ocr : {}),
  Capacitor: { isNativePlatform: () => mocks.platform.isNative },
}));
vi.mock('../platform', () => mocks.platform);
vi.mock('../appleAI', () => ({ appleAIStatus: mocks.appleStatus, classifyWithApple: mocks.apple }));
vi.mock('../ai', () => ({ readInvoiceWithClaude: mocks.claudeRead, classifyWithClaude: mocks.claudeClassify }));
vi.mock('tesseract.js', () => ({
  createWorker: async () => ({ recognize: async () => ({ data: { text: await mocks.tesseract() } }), terminate: async () => {} }),
}));
vi.mock('../ocr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ocr')>()),
  toJpeg: async () => ({ base64: 'Rk9UTw==', blob: new Blob(['foto'], { type: 'image/jpeg' }), width: 1000, height: 2000 }),
}));

const { readInvoice } = await import('../readInvoice');

/** QR de un e-Ticket de Disco (el hash es inventado) */
const QR = ' https://www.efactura.dgi.gub.uy/consultaQR/cfe?210274130017,101,BJ,1000001,1620.19,20261017,q7RxP4d+NzWmLbAeTf3VD+/9kuo=';
const DGI_URL = QR.trim();

/** Lo que lee Vision de la foto de ese ticket (con el TOTAL mal leído: 1820 en vez de 1620) */
const PHOTO = `Disco
Rut: 210274130017
e-Ticket
BJ1000001 17/10/2026
AGUJA SIN HUESO 422.36
BONDIOLA ENTER MEDIA 248.83
PANAL BABYSEC PREMIU 949.00
TOTAL: $ 1820.19
Cod. de Seguridad: q7RxP4`;

/** Los renglones del PDF oficial (Rondanet), como los devuelve el plugin */
const RONDANET = [
  '# IVA CÓDIGO DESCRIPCIÓN CANTIDAD DESC. REC. PRECIO C/IVA MONTO',
  '1 10% 301323 BONDIOLA ENTER MEDIA 1,670 0,00 0,00 149,00 248,83',
  '2 10% 301229 AGUJA SIN HUESO 1,324 0,00 0,00 319,00 422,36',
  '3 22% 622458 PANAL BABYSEC PREMIU 1,000 0,00 0,00 949,00 949,00',
  'TOTALES',
  'TOTAL A PAGAR 1.620,19',
];
const OFFICIAL_ITEMS = [
  ['BONDIOLA ENTER MEDIA', 248.83],
  ['AGUJA SIN HUESO', 422.36],
  ['PANAL BABYSEC PREMIU', 949],
];

/** Un renglón por caja, de arriba abajo */
const boxes = (text: string): TextBox[] => text.split('\n').map((t, i) => ({ text: t, x: 0.05, y: 0.02 + i * 0.04, w: 0.8, h: 0.02 }));
const photoSays = (text: string, qr: string[] = []) => mocks.ocr.recognize.mockResolvedValue({ boxes: boxes(text), qr });

const photo = () => new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: 'image/heic' });
const pairs = (d: { items: { description: string; amount: number }[] }) => d.items.map((i) => [i.description, i.amount]);

function makeData(apiKey = ''): Data {
  const d: Data = { ...emptyData(), ...templateData() };
  d.settings = { ...d.settings, ai: { ...d.settings.ai, apiKey } };
  return d;
}
const idOf = (d: Data, name: string) => d.rubros.find((r) => r.name === name)!.id;

beforeEach(() => {
  mocks.platform.isNative = true;
  mocks.platform.isPreview = false;
  mocks.ocr.recognize.mockReset();
  mocks.ocr.fetchCfe.mockReset();
  mocks.ocr.fetchCfe.mockResolvedValue({ lines: RONDANET });
  mocks.appleStatus.mockResolvedValue('unsupported');
  mocks.apple.mockReset().mockResolvedValue(new Map());
  mocks.claudeRead.mockReset();
  mocks.claudeClassify.mockReset().mockResolvedValue(new Map());
  mocks.tesseract.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ticket con el QR de la DGI, en el iPhone', () => {
  it('pide el QR con el texto y trae el ticket oficial: renglones exactos, total, fecha y comercio', async () => {
    photoSays(PHOTO, ['https://www.disco.com.uy', QR]);
    const progress: string[] = [];
    const d = await readInvoice(photo(), makeData(), (m) => progress.push(m));
    expect(mocks.ocr.recognize).toHaveBeenCalledWith({ image: 'Rk9UTw==', qr: true });
    expect(mocks.ocr.fetchCfe).toHaveBeenCalledWith({
      ruc: '210274130017', tipo: '101', serie: 'BJ', numero: '1000001', total: '1620.19', hash6: 'q7RxP4', portal: 'rondanet',
    });
    expect(progress).toContain('Trayendo el ticket oficial…');
    expect(pairs(d)).toEqual(OFFICIAL_ITEMS);
    expect(d).toMatchObject({ merchant: 'Disco', date: '2026-10-17', total: 1620.19, source: 'telefono', dgi: { from: 'oficial', url: DGI_URL } });
    expect(d.notice).toBeUndefined();
    expect(d).toMatchObject({ fileName: 'IMG_0001.jpg', mime: 'image/jpeg' });
  });

  it('los renglones oficiales pasan por las sugerencias de rubro (lo aprendido, el comercio y Apple Intelligence)', async () => {
    photoSays(PHOTO, [QR]);
    const data = makeData();
    // Sin la palabra «disco» en Supermercado, los renglones que no se conocen van a Apple Intelligence
    data.rubros = data.rubros.map((r) => (r.name === 'Supermercado' ? { ...r, keywords: [] } : r));
    data.settings.learned = { [itemKey('PANAL BABYSEC PREMIU')!]: idOf(data, 'Farmacia') };
    mocks.appleStatus.mockResolvedValue('available');
    mocks.apple.mockImplementation(async (qs: { id: string; text: string }[]) => new Map(qs.map((q) => [q.id, 'Carnicería'])));
    const d = await readInvoice(photo(), data, () => {});
    expect(mocks.apple.mock.calls[0][0].map((q: { text: string }) => q.text)).toEqual(['BONDIOLA ENTER MEDIA (en Disco)', 'AGUJA SIN HUESO (en Disco)']);
    expect(d.items.map((i) => [i.description, i.rubroId, i.reason])).toEqual([
      ['BONDIOLA ENTER MEDIA', idOf(data, 'Carnicería'), 'apple'],
      ['AGUJA SIN HUESO', idOf(data, 'Carnicería'), 'apple'],
      ['PANAL BABYSEC PREMIU', idOf(data, 'Farmacia'), 'aprendido'],
    ]);
  });

  it('si el súper todavía no lo publicó: lo leído de la foto, con el total y la fecha del QR, y dice por qué', async () => {
    photoSays(PHOTO.replace('Disco\n', 'SUPERMERCADOS DEL URUGUAY\n').replace(' 17/10/2026', ''), [QR]);
    mocks.ocr.fetchCfe.mockRejectedValue(Object.assign(new Error('Datos no válidos'), { code: 'no-publicado' }));
    const data = makeData();
    const d = await readInvoice(photo(), data, () => {});
    expect(d).toMatchObject({ merchant: 'Disco', date: '2026-10-17', total: 1620.19, source: 'telefono', dgi: { from: 'qr', url: DGI_URL } });
    expect(pairs(d)).toEqual(expect.arrayContaining([['AGUJA SIN HUESO', 422.36], ['PANAL BABYSEC PREMIU', 949]]));
    expect(d.notice).toMatch(/todavía no publicó el ticket oficial: mañana sacale la foto de nuevo/);
    // Igual les busca el rubro (por el comercio del RUT)
    expect(d.items.find((i) => i.description === 'AGUJA SIN HUESO')!.rubroId).toBe(idOf(data, 'Supermercado'));
  });

  it('sin conexión, una app vieja o un PDF que no se entiende: lo leído, con el motivo', async () => {
    photoSays(PHOTO, [QR]);
    mocks.ocr.fetchCfe.mockRejectedValue(Object.assign(new Error('Sin conexión'), { code: 'red' }));
    expect((await readInvoice(photo(), makeData(), () => {})).notice).toMatch(/^Sin conexión para traer el ticket oficial/);
    mocks.ocr.fetchCfe.mockRejectedValue(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
    expect((await readInvoice(photo(), makeData(), () => {})).notice).toMatch(/^No se pudo leer el ticket oficial/);
    mocks.ocr.fetchCfe.mockResolvedValue({ lines: ['Bienvenido', 'Nada por acá'] });
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(d.notice).toMatch(/^No se pudo leer el ticket oficial/);
    expect(d).toMatchObject({ total: 1620.19, dgi: { from: 'qr' } });
  });

  it('si el portal no contesta, se corta a los 25 segundos', async () => {
    vi.useFakeTimers();
    photoSays(PHOTO, [QR]);
    mocks.ocr.fetchCfe.mockReturnValue(new Promise(() => {}));
    const reading = readInvoice(photo(), makeData(), () => {});
    await vi.advanceTimersByTimeAsync(25_000);
    const d = await reading;
    expect(d.notice).toMatch(/^Sin conexión para traer el ticket oficial/);
    expect(d).toMatchObject({ total: 1620.19, dgi: { from: 'qr' } });
  });

  it('si la foto cierra mejor que el ticket oficial (que sigue en otra página), la foto', async () => {
    photoSays('DISCO\nAGUJA SIN HUESO 422.36\nBONDIOLA ENTER MEDIA 248.83\nPANAL BABYSEC PREMIU 949.00\nTOTAL: $ 1620.19', [QR]);
    mocks.ocr.fetchCfe.mockResolvedValue({ lines: [...RONDANET.slice(0, 3), 'TOTAL A PAGAR 1.620,19'] });
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(pairs(d)).toEqual([['AGUJA SIN HUESO', 422.36], ['BONDIOLA ENTER MEDIA', 248.83], ['PANAL BABYSEC PREMIU', 949]]);
    expect(d).toMatchObject({ merchant: 'Disco', dgi: { from: 'qr' } });
    expect(d.notice).toBeUndefined();
  });

  it('un comercio sin portal conocido: solo el total y la fecha del QR', async () => {
    const other = QR.replace('210274130017', '219999990011');
    photoSays('ALMACEN PEPE\nYERBA 250,00\nTOTAL 260,00', [other]);
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(mocks.ocr.fetchCfe).not.toHaveBeenCalled();
    expect(d).toMatchObject({ merchant: 'ALMACEN PEPE', total: 1620.19, date: '2026-10-17', dgi: { from: 'qr', url: other.trim() } });
    expect(d.notice).toBeUndefined();
  });

  it('sin QR, con los códigos impresos: también trae el ticket oficial (sin link a la DGI)', async () => {
    photoSays(PHOTO.replace('1820.19', '1620.19'));
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(mocks.ocr.fetchCfe).toHaveBeenCalledWith(expect.objectContaining({ hash6: 'q7RxP4', total: '1620.19' }));
    expect(pairs(d)).toEqual(OFFICIAL_ITEMS);
    expect(d.dgi).toEqual({ from: 'oficial', url: null });
  });

  it('lo impreso sin código de seguridad: no se pide, sin sello, pero el comercio sale del RUT', async () => {
    photoSays(PHOTO.replace('Disco\n', 'SUPERMERCADOS\n').replace(/Cod\. de Seguridad.*/, ''));
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(mocks.ocr.fetchCfe).not.toHaveBeenCalled();
    expect(d.dgi).toBeUndefined();
    expect(d.merchant).toBe('Disco');
    expect(d.total).toBe(1820.19);
  });

  it('una foto que no es un e-Ticket: como siempre', async () => {
    photoSays('FERIA DEL BARRIO\nTOMATES 120,00\nTOTAL 120,00');
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(mocks.ocr.fetchCfe).not.toHaveBeenCalled();
    expect(d).toMatchObject({ merchant: 'FERIA DEL BARRIO', total: 120, dgi: undefined, notice: undefined });
    expect(pairs(d)).toEqual([['TOMATES', 120]]);
  });

  it('ticket de súper con un descuento debajo de un producto: el descuento va al rubro de ese producto (sin preguntarle a la IA)', async () => {
    photoSays('TA-TA\nAGUJA SIN HUESO 422,36\n1,324 KG x 319,00\nDCTO SOCIO -42,24\nLECHE CONAPROLE 91,80\n2 x 45,90\nTOTAL $ 471,92');
    const data = makeData();
    data.rubros = data.rubros.map((r) => ({ ...r, keywords: [] }));
    data.settings.learned = { [itemKey('LECHE CONAPROLE')!]: idOf(data, 'Supermercado') };
    mocks.appleStatus.mockResolvedValue('available');
    mocks.apple.mockImplementation(async (qs: { id: string; text: string }[]) => new Map(qs.map((q) => [q.id, 'Carnicería'])));
    const d = await readInvoice(photo(), data, () => {});
    expect(mocks.apple.mock.calls.flatMap((c) => c[0].map((q: { text: string }) => q.text))).toEqual(['AGUJA SIN HUESO (en Ta-Ta)']);
    expect(d.items.map((i) => [i.description, i.amount, i.rubroId, i.reason])).toEqual([
      ['AGUJA SIN HUESO', 422.36, idOf(data, 'Carnicería'), 'apple'],
      ['DCTO SOCIO', -42.24, idOf(data, 'Carnicería'), 'apple'],
      ['LECHE CONAPROLE', 91.8, idOf(data, 'Supermercado'), 'aprendido'],
    ]);
  });
});

describe('con Claude', () => {
  const claudeSays = { merchant: 'Supermercados Disco', date: '2026-10-18', total: 1820.19, items: [{ description: 'Aguja sin hueso', amount: 422.36, rubro: 'Carnicería' }] };

  it('con el ticket oficial no hace falta que Claude lea la foto', async () => {
    photoSays(PHOTO, [QR]);
    const d = await readInvoice(photo(), makeData('sk-ant-x'), () => {});
    expect(mocks.claudeRead).not.toHaveBeenCalled();
    expect(pairs(d)).toEqual(OFFICIAL_ITEMS);
    expect(d.dgi).toEqual({ from: 'oficial', url: DGI_URL });
  });

  it('sin QR (los códigos leídos de lo impreso), «no coinciden» puede ser un código mal leído: no promete que mañana ande', async () => {
    photoSays(PHOTO, []);
    mocks.ocr.fetchCfe.mockRejectedValue(Object.assign(new Error('Datos no válidos'), { code: 'no-publicado' }));
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(d.notice).toMatch(/no encontró el ticket con los datos leídos de la foto/);
  });

  it('si no se pudo traer, lee Claude y el QR corrige el total, la fecha y el comercio', async () => {
    photoSays(PHOTO, [QR]);
    mocks.ocr.fetchCfe.mockRejectedValue(Object.assign(new Error(''), { code: 'no-publicado' }));
    mocks.claudeRead.mockResolvedValue(claudeSays);
    const data = makeData('sk-ant-x');
    const d = await readInvoice(photo(), data, () => {});
    expect(d).toMatchObject({ source: 'ia', merchant: 'Disco', date: '2026-10-17', total: 1620.19, dgi: { from: 'qr', url: DGI_URL } });
    expect(d.items).toEqual([{ description: 'Aguja sin hueso', amount: 422.36, rubroId: idOf(data, 'Supermercado'), reason: 'comercio' }]);
    expect(d.notice).toMatch(/todavía no publicó/);
  });

  it('si Vision falla, Claude lee la foto igual', async () => {
    mocks.ocr.recognize.mockRejectedValue(new Error('VISION_ERROR'));
    mocks.claudeRead.mockResolvedValue(claudeSays);
    const d = await readInvoice(photo(), makeData('sk-ant-x'), () => {});
    expect(d).toMatchObject({ source: 'ia', merchant: 'Supermercados Disco', total: 1820.19, dgi: undefined });
  });

  it('si Claude falla, los dos avisos', async () => {
    photoSays(PHOTO, [QR]);
    mocks.ocr.fetchCfe.mockRejectedValue(Object.assign(new Error(''), { code: 'red' }));
    mocks.claudeRead.mockRejectedValue(Object.assign(new Error('401'), { status: 401 }));
    const d = await readInvoice(photo(), makeData('sk-ant-x'), () => {});
    expect(d.source).toBe('telefono');
    expect(d.notice).toBe('La clave de Claude no es válida: revisala en Ajustes; se leyó con el teléfono. Sin conexión para traer el ticket oficial: quedó lo leído de la foto.');
    expect(d.total).toBe(1620.19);
  });
});

describe('en la web no cambia nada', () => {
  it('sin Vision no hay QR ni ticket oficial: se lee el texto con Tesseract', async () => {
    mocks.platform.isNative = false;
    mocks.tesseract.mockResolvedValue(`${PHOTO}\n${QR}`);
    const d = await readInvoice(photo(), makeData(), () => {});
    expect(mocks.ocr.recognize).not.toHaveBeenCalled();
    expect(mocks.ocr.fetchCfe).not.toHaveBeenCalled();
    expect(d).toMatchObject({ merchant: 'Disco', total: 1820.19, dgi: undefined, notice: undefined });
  });
});
