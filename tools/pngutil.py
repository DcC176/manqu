"""Minimal PNG reader/writer (stdlib only) — RGBA8 in, RGBA8 out."""

import struct, zlib


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'

    pos = 8
    w = h = bit = ctype = None
    idat = bytearray()
    palette = None
    trns = None

    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        ctag = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length

        if ctag == b'IHDR':
            w, h, bit, ctype = struct.unpack('>IIBB', chunk[:10])
        elif ctag == b'PLTE':
            palette = chunk
        elif ctag == b'tRNS':
            trns = chunk
        elif ctag == b'IDAT':
            idat += chunk
        elif ctag == b'IEND':
            break

    assert bit == 8, f'unsupported bit depth {bit}'
    channels = {0: 1, 2: 3, 4: 2, 6: 4, 3: 1}[ctype]
    raw = zlib.decompress(bytes(idat))
    stride = w * channels

    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0

    for y in range(h):
        ftype = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride

        if ftype == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                ul = prev[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(left, prev[i], ul)) & 0xFF

        prev = line
        base = y * w * 4

        if ctype == 6:
            out[base:base + w * 4] = line
        elif ctype == 2:
            for x in range(w):
                s = x * 3
                d = base + x * 4
                out[d] = line[s]
                out[d + 1] = line[s + 1]
                out[d + 2] = line[s + 2]
                out[d + 3] = 255
        elif ctype == 0:
            for x in range(w):
                v = line[x]
                d = base + x * 4
                out[d] = out[d + 1] = out[d + 2] = v
                out[d + 3] = 255
        elif ctype == 4:
            for x in range(w):
                v, a = line[x * 2], line[x * 2 + 1]
                d = base + x * 4
                out[d] = out[d + 1] = out[d + 2] = v
                out[d + 3] = a
        elif ctype == 3:
            for x in range(w):
                idx = line[x]
                d = base + x * 4
                out[d] = palette[idx * 3]
                out[d + 1] = palette[idx * 3 + 1]
                out[d + 2] = palette[idx * 3 + 2]
                out[d + 3] = trns[idx] if trns and idx < len(trns) else 255

    return w, h, out


def write_png(path, w, h, rgba):
    raw = b''.join(b'\x00' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack('>I', len(payload)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)
