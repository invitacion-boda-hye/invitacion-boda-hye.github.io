/** Validación estructural acotada; no sustituye una decodificación completa. */
export function inspectJpeg(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 4 || data.length > 2097152 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2, width = 0, height = 0, scan = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) return null;
    while (offset < data.length && data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) return scan && width && height && offset === data.length ? { width, height } : null;
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null;
    if (offset + 2 > data.length) return null;
    const length = data[offset] * 256 + data[offset + 1];
    if (length < 2 || offset + length > data.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || width) return null;
      height = data[offset + 3] * 256 + data[offset + 4];
      width = data[offset + 5] * 256 + data[offset + 6];
      if (!width || !height || width > 10000 || height > 10000 || width * height > 40000000) return null;
    }
    offset += length;
    if (marker === 0xda) {
      if (!width || !height) return null;
      scan = true;
      while (offset < data.length) {
        if (data[offset] !== 0xff) { offset++; continue; }
        if (offset + 1 >= data.length) return null;
        const next = data[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
    }
  }
  return null;
}
