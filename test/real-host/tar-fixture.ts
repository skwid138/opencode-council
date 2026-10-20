// Test-only in-memory tar.gz builder. Adapted from the archive builders in
// test/real-host/artifacts.test.ts (normalizer commit 7ddab8d6); see test/PROVENANCE.md.
import { gzipSync } from "node:zlib";

function tarHeader(name: string, { size = 0, type = "0", linkname = "", mode = 0o644 } = {}): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write(linkname, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return header;
}

export type TarItem = { name: string; data?: string | Buffer; type?: string; linkname?: string; mode?: number };

export function tgz(items: TarItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? "");
    parts.push(tarHeader(item.name, { size: data.length, type: item.type ?? "0", linkname: item.linkname, mode: item.mode }));
    if (data.length > 0) parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
