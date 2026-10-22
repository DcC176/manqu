"""从原图恢复被抠掉的光环，并合成扩展图标（16/48/128）。

用法：
    python build-icon.py <抠图结果.png>
"""

import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pngutil import read_png, write_png

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = r'C:\Users\SZE\.workbuddy\clipboard-images\clipboard-2026-10-21T10-14-53-066Z-3b6f1f4b.png'

BR, BG, BB = 244, 206, 214          # 原图背景粉
HALO_BOX = (104, 14, 214, 45)       # 光环所在矩形（收窄右界以避开爱心）


def main():
    cut_path = sys.argv[1]
    W, H, A = read_png(SRC)
    W2, H2, B = read_png(cut_path)
    assert (W, H) == (W2, H2), 'size mismatch'

    out = bytearray(B)

    x0, y0, x1, y1 = HALO_BOX
    for y in range(y0, y1):
        for x in range(x0, x1):
            i = (y * W + x) * 4
            if out[i + 3] > 200:         # 只跳过实心人物像素
                continue
            r, g, b = A[i], A[i + 1], A[i + 2]
            d = abs(r - BR) + abs(g - BG) + abs(b - BB)
            if d <= 10:                  # 仍是背景
                continue
            t = min(1.0, (d - 10) / 20.0)
            out[i], out[i + 1], out[i + 2] = r, g, b
            out[i + 3] = max(out[i + 3], int(t * 255))

    os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)
    char_path = os.path.join(ROOT, 'assets', 'character.png')
    write_png(char_path, W, H, out)
    print('character ->', char_path)

    # ---- 计算包围盒 ----
    minx, miny, maxx, maxy = W, H, -1, -1
    for y in range(H):
        row = y * W * 4
        for x in range(W):
            if out[row + x * 4 + 3] > 16:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    bw, bh = maxx - minx + 1, maxy - miny + 1
    print('bbox', (minx, miny, maxx, maxy), 'size', (bw, bh))

    # ---- 合成画布：粉色底 + 人物居中 ----
    def compose(S, circular, fill):
        canvas = bytearray(S * S * 4)
        R = S * 0.5 - 2
        corner = max(2.0, S * 0.2)

        for y in range(S):
            for x in range(S):
                px, py = x + 0.5, y + 0.5
                if circular:
                    dx, dy = px - S / 2, py - S / 2
                    inside = dx * dx + dy * dy <= R * R
                else:
                    dx = max(corner - px, px - (S - corner), 0.0)
                    dy = max(corner - py, py - (S - corner), 0.0)
                    inside = dx * dx + dy * dy <= corner * corner
                if inside:
                    i = (y * S + x) * 4
                    canvas[i], canvas[i + 1], canvas[i + 2], canvas[i + 3] = 247, 201, 214, 255

        scale = (S * fill) / bh
        dw, dh = bw * scale, bh * scale
        ox, oy = (S - dw) / 2, (S - dh) / 2

        for y in range(max(0, int(oy)), min(S, int(oy + dh) + 1)):
            for x in range(max(0, int(ox)), min(S, int(ox + dw) + 1)):
                sx = minx + (x - ox) / scale
                sy = miny + (y - oy) / scale
                ix, iy = int(sx), int(sy)
                if not (0 <= ix < W and 0 <= iy < H):
                    continue
                j = (iy * W + ix) * 4
                a = out[j + 3] / 255.0
                if a <= 0.004:
                    continue
                i2 = (y * S + x) * 4
                for k in range(3):
                    canvas[i2 + k] = int(out[j + k] * a + canvas[i2 + k] * (1 - a))
                canvas[i2 + 3] = 255
        return canvas

    # ---- 降采样 ----
    def resize(src, sw, dw, dh=None):
        dh = dh or dw
        res = bytearray(dw * dh * 4)
        sx, sy = sw / dw, sw / dh
        for dy in range(dh):
            y0, y1 = int(dy * sy), max(int(dy * sy) + 1, int((dy + 1) * sy))
            for dx in range(dw):
                x0, x1 = int(dx * sx), max(int(dx * sx) + 1, int((dx + 1) * sx))
                rs = gs = bs = as_ = 0
                n = 0
                for yy in range(y0, min(y1, sw)):
                    for xx in range(x0, min(x1, sw)):
                        k = (yy * sw + xx) * 4
                        aa = src[k + 3] / 255.0
                        rs += src[k] * aa
                        gs += src[k + 1] * aa
                        bs += src[k + 2] * aa
                        as_ += aa
                        n += 1
                k2 = (dy * dw + dx) * 4
                if as_ > 0:
                    res[k2] = min(255, int(rs / as_ + .5))
                    res[k2 + 1] = min(255, int(gs / as_ + .5))
                    res[k2 + 2] = min(255, int(bs / as_ + .5))
                res[k2 + 3] = min(255, int(255 * as_ / max(n, 1) + .5))
        return res

    icons = os.path.join(ROOT, 'icons')
    os.makedirs(icons, exist_ok=True)

    for size in (128, 48):
        write_png(os.path.join(icons, f'icon{size}.png'), size, size,
                  resize(compose(512, True, 0.82), 512, size))
        print('icon', size, 'ok')

    # 16px 在工具栏上圆形会显得偏小，改用更满的圆角方形 + 更大人物占比
    write_png(os.path.join(icons, 'icon16.png'), 16, 16,
              resize(compose(256, False, 0.94), 256, 16))
    print('icon 16 ok')


if __name__ == '__main__':
    main()
