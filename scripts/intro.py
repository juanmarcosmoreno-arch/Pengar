"""
La entrada de la app: el suricata sale del pozo, mira alrededor y se vuelve a meter (docs/marca/suricata-intro.webp,
15 cuadros dibujados a mano). Recorta cada cuadro, le saca el papel y lo alinea sobre el pozo, que queda siempre en
el mismo lugar: src/assets/intro/f01.webp … f15.webp, transparentes y del mismo tamaño. Los tiempos de cada cuadro
están en src/assets/intro/timing.json (los usa la app y el video).

Uso: python3 scripts/intro.py            (necesita Pillow y numpy)
     python3 scripts/intro.py --video    además arma docs/marca/intro-suricata.mp4 (necesita ffmpeg)
"""
import json, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SHEET = os.path.join(ROOT, 'docs/marca/suricata-intro.webp')
OUT = os.path.join(ROOT, 'src/assets/intro')
BG = (245, 243, 238)  # crema de la app (#F5F3EE)
INK = (34, 46, 42)
SCALE = 2  # el dibujo es chico: al doble se ve bien en la pantalla del iPhone


def unpaper(im):
    """Igual que en suricata.py: el papel queda transparente y el trazo conserva su color."""
    a = np.asarray(im.convert('RGB')).astype(np.float32)
    bg = im.convert('RGB').filter(ImageFilter.MaxFilter(25)).filter(ImageFilter.GaussianBlur(20))
    b = np.maximum(np.asarray(bg).astype(np.float32), 1)
    alpha = np.clip((b - a) / b, 0, 1).max(axis=2)
    alpha = np.clip((alpha - 0.11) / 0.45, 0, 1) ** 0.85
    safe = np.maximum(alpha, 1e-3)[..., None]
    col = np.clip((a - b * (1 - safe)) / safe, 0, 255)
    return Image.fromarray(np.dstack([col, alpha * 255]).astype(np.uint8), 'RGBA')


def fill_inside(im, faint=40):
    """Rellena el interior de las siluetas con la crema de la app (la panza no queda transparente) y borra la textura suelta."""
    a = np.asarray(im.getchannel('A'))
    closed = Image.fromarray(((a > 60) * 255).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(7))
    pad = Image.new('L', (closed.width + 4, closed.height + 4), 0)
    pad.paste(closed, (2, 2))
    ImageDraw.floodfill(pad, (0, 0), 128)
    outside = np.asarray(pad)[2:-2, 2:-2] == 128
    inside = Image.fromarray(((~outside) * 255).astype(np.uint8), 'L').filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(1))
    arr = np.asarray(im).copy()
    arr[outside & (arr[..., 3] < faint), 3] = 0
    im = Image.fromarray(arr, 'RGBA')
    base = Image.new('RGBA', im.size, BG + (0,))
    base.putalpha(inside)
    return Image.alpha_composite(base, im)


# Los 15 cuadros de la hoja (5 por fila), sin el marco
ROWS = [(11, 281), (334, 613), (663, 961)]
COLS = [(11, 303), (316, 609), (621, 914), (927, 1220), (1232, 1525)]
BOXES = [(x0 + 4, y0 + 4, x1 - 3, y1 - 3) for (y0, y1) in ROWS for (x0, x1) in COLS]
# Línea del piso y centro del pozo en cada cuadro (medidos sobre el dibujo). En 11 a 13 está parado afuera y tapa el pozo
GROUND = [216, 216, 216, 217, 216, 238, 241, 244, 241, 239, 262, 262, 263, 259, 251]
HOLE = [134, 141, 139, 135, 138, 127, 127, 127, 129, 135, 137, 137, 137, 128, 141]
# Lienzo común: el pozo siempre en (GX, GY)
W, H, GX, GY = 300, 290, 150, 256


def frames(scale=SCALE):
    sheet = unpaper(Image.open(SHEET))
    out = []
    for i, box in enumerate(BOXES):
        p = fill_inside(sheet.crop(box))
        c = Image.new('RGBA', (W, H), BG + (0,))
        c.paste(p, (GX - HOLE[i], GY - GROUND[i]), p)
        out.append(c.resize((W * scale, H * scale), Image.LANCZOS))
    return out


def video(timing, path, fps=30):
    """Video vertical (1080×1920) con la misma secuencia y tiempos que la app, y el nombre debajo."""
    VW, VH, FADE = 1080, 1920, 0.07
    imgs = frames(3)  # 900 px de ancho, sin agrandar dos veces
    fw, fh = imgs[0].size
    ground = int(VH * 0.56)
    ox, oy = (VW - fw) // 2, ground - round(fh * GY / H)
    font = ImageFont.truetype(os.path.join(ROOT, 'node_modules/@fontsource/patrick-hand/files/patrick-hand-latin-400-normal.woff'), 170)
    word = Image.new('RGBA', (VW, 260), (0, 0, 0, 0))
    d = ImageDraw.Draw(word)
    d.text(((VW - d.textlength('Pengar', font=font)) / 2, 20), 'Pengar', font=font, fill=INK + (255,))
    starts, t = [], 0.0
    for k, dur in timing:
        starts.append((t, k - 1))
        t += dur
    total = t + 0.6
    tmp = tempfile.mkdtemp()
    try:
        for n in range(int(total * fps)):
            t = n / fps
            idx = max(i for i, (s, _) in enumerate(starts) if s <= t)
            s, k = starts[idx]
            img = imgs[k]
            if idx > 0 and t - s < FADE:
                img = Image.blend(imgs[starts[idx - 1][1]], img, (t - s) / FADE)
            c = Image.new('RGBA', (VW, VH), BG + (255,))
            c.alpha_composite(img, (ox, oy))
            wa = min(1, max(0, (t - 0.15) / 0.5))
            if wa > 0:
                w2 = word.copy()
                w2.putalpha(word.getchannel('A').point(lambda v: int(v * wa)))
                c.alpha_composite(w2, (0, ground + 70))
            c.convert('RGB').save(os.path.join(tmp, f'{n:04d}.png'))
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', os.path.join(tmp, '%04d.png'),
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', path], check=True)
    finally:
        shutil.rmtree(tmp)
    print('video', os.path.relpath(path, ROOT), f'{total:.1f} s')


imgs = frames()
os.makedirs(OUT, exist_ok=True)
for i, f in enumerate(imgs, 1):
    f.save(os.path.join(OUT, f'f{i:02d}.webp'), 'WEBP', quality=90, method=6)
print('cuadros', len(imgs), imgs[0].size)
if '--video' in sys.argv:
    timing = json.load(open(os.path.join(OUT, 'timing.json')))
    video(timing, os.path.join(ROOT, 'docs/marca/intro-suricata.mp4'))
