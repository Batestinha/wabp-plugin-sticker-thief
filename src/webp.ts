export interface WebPInfo {
  width: number;
  height: number;
  animated: boolean;
}

/**
 * Reads canvas size and the animation flag from a WebP RIFF header without
 * decoding pixels. Returns undefined for anything that is not WebP.
 */
export function parseWebPInfo(data: Uint8Array): WebPInfo | undefined {
  if (data.length < 30) return undefined;
  const ascii = (start: number, end: number) => String.fromCharCode(...data.subarray(start, end));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 12) !== 'WEBP') return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const p = 20;
  const u24 = (offset: number) => (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8) | ((data[offset + 2] ?? 0) << 16);
  switch (ascii(12, 16)) {
    case 'VP8X':
      return { animated: ((data[p] ?? 0) & 0x02) !== 0, width: u24(p + 4) + 1, height: u24(p + 7) + 1 };
    case 'VP8 ':
      if (data[p + 3] !== 0x9d || data[p + 4] !== 0x01 || data[p + 5] !== 0x2a) return undefined;
      return { animated: false, width: view.getUint16(p + 6, true) & 0x3fff, height: view.getUint16(p + 8, true) & 0x3fff };
    case 'VP8L': {
      if (data[p] !== 0x2f) return undefined;
      const bits = view.getUint32(p + 1, true);
      return { animated: false, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    default:
      return undefined;
  }
}
