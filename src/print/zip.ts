// A one-file, uncompressed ZIP. The claude.ai artifact viewer only lets a page
// save files with allowlisted extensions, and .stl is not one of them; .zip is.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zipOne(name: string, data: Uint8Array): Blob {
  const fileName = new TextEncoder().encode(name);
  const crc = crc32(data);
  const DOS_DATE = 0x21; // 1980-01-01, the format's epoch

  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true); // version needed
  local.setUint16(6, 0x0800, true); // UTF-8 names
  local.setUint16(8, 0, true); // stored, no compression
  local.setUint16(12, DOS_DATE, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, fileName.length, true);

  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true); // version made by
  central.setUint16(6, 20, true); // version needed
  central.setUint16(8, 0x0800, true);
  central.setUint16(14, DOS_DATE, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, fileName.length, true);
  // local header offset (42) is 0: the one entry starts the archive

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + fileName.length, true);
  end.setUint32(16, 30 + fileName.length + data.length, true);

  return new Blob([local, fileName, data as Uint8Array<ArrayBuffer>, central, fileName, end], { type: 'application/zip' });
}
