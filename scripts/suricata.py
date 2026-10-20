"""
Recorta las poses del suricata (docs/marca) y les saca el fondo de papel: quedan PNG/WebP transparentes en
src/assets/suricata. El interior de la silueta se rellena con papel crema para que la panza no quede transparente.
Uso: python3 scripts/suricata.py   (necesita Pillow y numpy)
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import numpy as np

import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
IMG = os.path.join(ROOT, 'docs/marca') + '/'
OUT = os.path.join(ROOT, 'src/assets/suricata')

def unpaper(im):
    a = np.asarray(im.convert('RGB')).astype(np.float32)
    # Papel local: lo más claro de la zona, suavizado (las líneas son finas, el papel cambia despacio)
    bg = im.convert('RGB').filter(ImageFilter.MaxFilter(25)).filter(ImageFilter.GaussianBlur(20))
    b = np.asarray(bg).astype(np.float32)
    b = np.maximum(b, 1)
    dark = np.clip((b - a) / b, 0, 1)
    alpha = dark.max(axis=2)
    # Quitar la textura del papel y reforzar el trazo
    alpha = np.clip((alpha - 0.11) / 0.45, 0, 1) ** 0.85
    safe = np.maximum(alpha, 1e-3)[..., None]
    col = (a - b * (1 - safe)) / safe
    col = np.clip(col, 0, 255)
    rgba = np.dstack([col, alpha * 255]).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA')

PAPER = (251, 248, 241)

def sticker(im, close_bottom=False):
    """Rellena el interior de la silueta con papel crema: la panza blanca no queda transparente."""
    from PIL import ImageDraw
    a = np.asarray(im.getchannel('A'))
    lines = Image.fromarray(((a > 60) * 255).astype(np.uint8), 'L')
    closed = lines.filter(ImageFilter.MaxFilter(9))
    if close_bottom:
        from PIL import ImageDraw as D
        D.Draw(closed).rectangle((0, closed.height - 6, closed.width, closed.height), fill=255)
    pad = Image.new('L', (closed.width + 4, closed.height + 4), 0)
    pad.paste(closed, (2, 2))
    ImageDraw.floodfill(pad, (0, 0), 128)
    outside = (np.asarray(pad)[2:-2, 2:-2] == 128)
    inside = Image.fromarray(((~outside) * 255).astype(np.uint8), 'L').filter(ImageFilter.MinFilter(7)).filter(ImageFilter.GaussianBlur(1.2))
    # Afuera de la silueta, la textura del papel que quedó (trazos muy tenues) se borra
    arr = np.asarray(im).copy()
    faint = outside & (arr[..., 3] < 90)
    arr[faint, 3] = 0
    im = Image.fromarray(arr, 'RGBA')
    base = Image.new('RGBA', im.size, PAPER + (0,))
    base.putalpha(inside)
    return Image.alpha_composite(base, im)

def trim(im, pad=8):
    bbox = im.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if not bbox: return im
    x0, y0, x1, y1 = bbox
    return im.crop((max(0, x0 - pad), max(0, y0 - pad), min(im.width, x1 + pad), min(im.height, y1 + pad)))

def save(im, name, maxh=520):
    im = sticker(trim(im))
    if im.height > maxh:
        im = im.resize((round(im.width * maxh / im.height), maxh), Image.LANCZOS)
    im.save(f'{OUT}/{name}.webp', 'WEBP', quality=88, method=6)
    print(name, im.size)

sheet = unpaper(Image.open(IMG + 'suricata-poses.webp'))
boxes = {
    'saludando': (255, 60, 470, 400), 'contento': (470, 50, 680, 400), 'ahorrando': (690, 120, 900, 400),
    'pensando': (895, 40, 1085, 400), 'calculadora': (1090, 90, 1270, 400), 'lista': (1285, 90, 1515, 400),
    'organizando': (20, 470, 245, 690), 'analizando': (245, 500, 475, 690), 'metas': (465, 455, 715, 695),
    'compras': (725, 480, 888, 695), 'transportes': (930, 480, 1110, 695), 'casa': (1130, 470, 1300, 695),
    'celebrando': (1320, 430, 1520, 695),
}
for name, box in boxes.items():
    save(sheet.crop(box), name)
faces = ['normal', 'feliz', 'sorprendido', 'pensando', 'preocupado', 'decidido', 'triste', 'entusiasmado', 'curioso']
starts = [35, 195, 355, 525, 680, 845, 1010, 1185, 1370]
for i, name in enumerate(faces):
    x0 = starts[i]
    x1 = starts[i + 1] - 5 if i + 1 < len(starts) else 1525
    save(sheet.crop((x0, 790, x1, 950)), f'cara-{name}', 300)

main = unpaper(Image.open(IMG + 'suricata-principal.webp').crop((230, 110, 980, 1160)))
save(main, 'principal', 640)

# --- Ilustraciones de categorías: cada una es un círculo de color con el suricata ------------------------
TILES = [
    ['mant-casa', 'comida', 'super', 'mant-auto', 'educacion', 'regalos', 'limpieza'],
    ['salud', 'deporte', 'viajes', 'entretenimiento', 'restaurantes', 'telefonia', 'ropa'],
    ['ahorro', 'servicios', 'libros', 'mascotas', 'vivienda', 'seguros', 'jardin'],
    ['tecnologia', 'hogar', 'salidas', 'familia', 'inversiones', 'otros', 'imprevistos'],
]
cats = Image.open(IMG + 'suricata-categorias.webp').convert('RGB')
R = 100
# Espejadas, para que no miren todas para el mismo lado (las que tienen letras o el $ quedan como están)
FLIP = {'comida', 'mant-auto', 'regalos', 'deporte', 'restaurantes', 'ropa', 'libros', 'mascotas', 'jardin', 'salidas', 'otros', 'vivienda', 'seguros'}
os.makedirs(os.path.join(OUT, 'cat'), exist_ok=True)
for r, row in enumerate(TILES):
    cy = [143, 398, 632, 868][r]
    for c, name in enumerate(row):
        cx = 117 + c * 217
        tile = cats.crop((cx - R, cy - R, cx + R, cy + R)).convert('RGBA')
        # Recorte redondo con el borde suave (queda como una medalla sobre el papel)
        mask = Image.new('L', (R * 8, R * 8), 0)
        ImageDraw.Draw(mask).ellipse((8, 8, R * 8 - 8, R * 8 - 8), fill=255)
        mask = mask.resize((R * 2, R * 2), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1))
        tile.putalpha(mask)
        if name in FLIP:
            tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
        tile.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, 'cat', f'{name}.webp'), 'WEBP', quality=86, method=6)
print('categorías', sum(len(r) for r in TILES))

# Segundo juego (docs/marca/suricata-categorias-2.png): otras versiones («-2») y dos categorías nuevas
TILES2 = [
    ['mant-casa-2', 'comida-2', 'super-2', 'mant-auto-2', 'educacion-2', 'regalos-2', 'limpieza-2'],
    ['ahorro-2', 'servicios-2', 'salud-2', 'deporte-2', 'viajes-2', 'entretenimiento-2', 'restaurantes-2'],
    ['tecnologia-2', 'hogar-2', 'ropa-2', 'libros-2', 'mascotas-2', 'vivienda-2', 'seguros-2'],
    ['jardin-2', 'salidas-2', 'familia-2', 'inversiones-2', 'compras-online', 'impuestos', 'otros-2'],
]
FLIP2 = {'comida-2', 'regalos-2', 'limpieza-2', 'deporte-2', 'restaurantes-2', 'ropa-2', 'libros-2', 'mascotas-2', 'jardin-2', 'vivienda-2', 'mant-casa-2'}
cats2 = Image.open(IMG + 'suricata-categorias-2.png').convert('RGB')
R2 = 102
for r, row in enumerate(TILES2):
    cy = [136, 388, 625, 858][r]
    for c, name in enumerate(row):
        cx = 127 + c * 215
        tile = cats2.crop((cx - R2, cy - R2, cx + R2, cy + R2)).convert('RGBA')
        mask = Image.new('L', (R2 * 8, R2 * 8), 0)
        ImageDraw.Draw(mask).ellipse((8, 8, R2 * 8 - 8, R2 * 8 - 8), fill=255)
        mask = mask.resize((R2 * 2, R2 * 2), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1))
        tile.putalpha(mask)
        if name in FLIP2:
            tile = tile.transpose(Image.FLIP_LEFT_RIGHT)
        tile.resize((192, 192), Image.LANCZOS).save(os.path.join(OUT, 'cat', f'{name}.webp'), 'WEBP', quality=86, method=6)
print('categorías (segundo juego)', sum(len(r) for r in TILES2))
