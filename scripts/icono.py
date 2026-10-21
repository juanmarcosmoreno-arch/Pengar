"""
Íconos de la app (iPhone y web) a partir del dibujo del ícono: docs/marca/icono-app.webp, el suricata asomándose
sobre papel, ya con las esquinas redondeadas.

El iPhone redondea el ícono por su cuenta y no acepta transparencia: para el iPhone (y el ícono de la web que se
agrega a la pantalla de inicio) el papel se extiende hasta las esquinas, sin el borde sombreado del dibujo. El
favicon conserva las esquinas redondeadas del dibujo, con el afuera transparente. La pantalla de arranque del iPhone
es el crema liso de la app, igual que el fondo donde empieza la animación de entrada.

Uso: python3 scripts/icono.py   (necesita Pillow y numpy)
"""
import os
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'docs/marca/icono-app.webp')
BG = (245, 243, 238)  # crema de la app (#F5F3EE)

src = Image.open(SRC).convert('RGB')
S = src.width
a = np.asarray(src).astype(np.float32)

# Adentro del redondeado: lo que no es el blanco de afuera (rellenando desde las esquinas)
outside_white = (a.min(axis=2) > 249).astype(np.uint8) * 255
flood = Image.fromarray(outside_white, 'L')
pad = Image.new('L', (S + 2, S + 2), 255)
pad.paste(flood, (1, 1))
for corner in [(0, 0), (S + 1, 0), (0, S + 1), (S + 1, S + 1)]:
    ImageDraw.floodfill(pad, corner, 128)
outside = np.asarray(pad)[1:-1, 1:-1] == 128
inside = Image.fromarray((~outside * 255).astype(np.uint8), 'L')

# Papel limpio para extender: la franja de arriba, sin dibujo, espejada en mosaico hasta cubrir todo
clean = src.crop((260, 50, 1000, 380))
cw, ch = clean.size
row = Image.new('RGB', (cw * 2, ch))
row.paste(clean, (0, 0))
row.paste(clean.transpose(Image.FLIP_LEFT_RIGHT), (cw, 0))
tile = Image.new('RGB', (cw * 2, ch * 2))
tile.paste(row, (0, 0))
tile.paste(row.transpose(Image.FLIP_TOP_BOTTOM), (0, ch))
paper = Image.new('RGB', (S, S))
for y in range(0, S, tile.height):
    for x in range(0, S, tile.width):
        paper.paste(tile, (x, y))

# El dibujo, sin el borde sombreado del redondeado (se achica la máscara y se funde suave con el papel). En los lados
# el redondeado llega al borde de la imagen: el borde cuenta como afuera para que también se achique ahí
edge = inside.copy()
ImageDraw.Draw(edge).rectangle((0, 0, S - 1, S - 1), outline=0, width=4)
core = edge.filter(ImageFilter.MinFilter(41)).filter(ImageFilter.GaussianBlur(14))
full = Image.composite(src, paper, core)


def save(img, size, path, mode='RGB'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.resize((size, size), Image.LANCZOS).convert(mode).save(path, optimize=True)
    print(os.path.relpath(path, ROOT), size)


# iPhone: 1024, opaco (App Store rechaza íconos con transparencia)
ios_icon = os.path.join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
if os.path.isdir(os.path.dirname(ios_icon)):
    save(full, 1024, ios_icon)
save(full, 180, os.path.join(ROOT, 'public/icons/apple-touch-icon.png'))
save(full, 512, os.path.join(ROOT, 'public/icons/icon-512.png'))

# Favicon y README: con las esquinas del dibujo, el afuera transparente
rounded = src.convert('RGBA')
rounded.putalpha(inside.filter(ImageFilter.GaussianBlur(1)))
save(rounded, 64, os.path.join(ROOT, 'public/favicon.png'), 'RGBA')
save(rounded, 512, os.path.join(ROOT, 'docs/icono.png'), 'RGBA')

# Pantalla de arranque del iPhone: crema liso
splash = os.path.join(ROOT, 'ios/App/App/Assets.xcassets/Splash.imageset')
if os.path.isdir(splash):
    for name in ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']:
        Image.new('RGB', (2732, 2732), BG).save(os.path.join(splash, name), optimize=True)
    print('pantalla de arranque')
