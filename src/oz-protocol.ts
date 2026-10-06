// CAU OZ data-module request and dataset codec.
// Adapted from OZRA (MIT), Copyright (c) 2023-2026 Koo Hyomin.
// Source: https://github.com/EATSTEAK/ozra/tree/9c6da3b9ab1169c3ac0b136625234e0d3553d07a
// License: ../third-party/ozra-LICENSE.txt
import { Buffer } from 'node:buffer';

const MAX_BYTES = 20 * 1024 * 1024;
function count(n: number, max = 10000) {
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error('Invalid OZ size/count');
  return n;
}
export class Reader {
  offset = 0;
  constructor(public buffer: Buffer) {
    if (buffer.length > MAX_BYTES) throw new Error('Oversized OZ response');
  }
  bytes(length: number) {
    count(length, MAX_BYTES);
    if (this.offset + length > this.buffer.length) throw new Error('Truncated OZ response');
    const b = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return b;
  }
  int() { return this.bytes(4).readInt32BE(); }
  short() { return this.bytes(2).readUInt16BE(); }
  byte() { return this.bytes(1)[0]; }
  bool() {
    const n = this.byte();
    if (n > 1) throw new Error('Invalid OZ boolean');
    return n === 1;
  }
  utf16() {
    const n = count(this.int(), MAX_BYTES / 2);
    return Buffer.from(this.bytes(n * 2)).swap16().toString('utf16le');
  }
  utf() {
    const prefix = this.short();
    const b = this.bytes(prefix === 65535 ? this.int() : prefix);
    // Java Modified UTF-8 encodes UTF-16 code units, including surrogate pairs.
    const units = [];
    for (let i = 0; i < b.length;) {
      const a = b[i++];
      if (a > 0 && a < 128) { units.push(a); continue; }
      const size = (a & 224) === 192 ? 2 : (a & 240) === 224 ? 3 : 0;
      if (!size || i + size - 1 > b.length) throw new Error('Invalid OZ UTF');
      let unit = a & (size === 2 ? 31 : 15);
      for (let j = 1; j < size; j++) {
        const next = b[i++];
        if ((next & 192) !== 128) throw new Error('Invalid OZ UTF');
        unit = (unit << 6) | (next & 63);
      }
      if ((size === 2 && unit < 128 && unit !== 0) || (size === 3 && unit < 2048)) {
        throw new Error('Overlong OZ UTF');
      }
      units.push(unit);
    }
    let result = '';
    for (let i = 0; i < units.length; i += 8192) result += String.fromCharCode(...units.slice(i, i + 8192));
    return result;
  }
}
class Writer {
  parts: Buffer[] = [];
  int(value: number) { const b = Buffer.alloc(4); b.writeInt32BE(value); this.parts.push(b); }
  byte(value: number) { this.parts.push(Buffer.from([value])); }
  utf16(value: string) { this.int(value.length); this.parts.push(Buffer.from(value, 'utf16le').swap16()); }
  finish() { return Buffer.concat(this.parts); }
}
function header(writer: Writer, name: string, sessionId: string) {
  writer.int(10001);
  writer.utf16(name);
  // CAU OZJSViewer capture (2026-10-06): 17 fields, fd='', rv=268435456.
  // Compact CAU request bodies: guest login is 398 bytes.
  const fields = {
    un: 'guest', p: 'guest', s: sessionId, cv: '20140527',
    t: '', i: '', o: '', z: '', j: '', d: '-1', r: '1',
    rv: '268435456', xi: '', xm: '', xh: '', pi: '', fd: '',
  };
  writer.int(Object.keys(fields).length);
  for (const [key, value] of Object.entries(fields)) { writer.utf16(key); writer.utf16(value); }
}
export function parseHeader(reader: Reader) {
  if (reader.int() !== 10001) throw new Error('Invalid OZ magic');
  const name = reader.utf16();
  if (name.includes('Exception')) throw new Error('OZ server returned an exception');
  const fields: Record<string, string> = Object.create(null);
  const size = count(reader.int(), 100);
  for (let i = 0; i < size; i++) { const key = reader.utf16(); fields[key] = reader.utf16(); }
  return { name, fields };
}
export function loginRequest() {
  const w = new Writer();
  header(w, 'oz.framework.cp.message.repository.OZRepositoryRequestUserLogin', '-1905');
  w.int(176);
  return w.finish();
}
export function dataRequest(sessionId: string, params: Record<string, string>) {
  const w = new Writer();
  header(w, 'oz.framework.cp.message.FrameworkRequestDataModule', sessionId);
  w.int(380);
  w.utf16('pUskLei008.odi');
  w.int(10000);
  w.utf16('/TIS/prof/usk');
  w.byte(0); w.byte(0); w.utf16('');
  w.int(Object.keys(params).length);
  for (const [key, value] of Object.entries(params)) { w.utf16(key); w.utf16(value); }
  // CAU data-module trailer observed 2026-10-06.
  for (const n of [2, 32, 17, 0, 0]) w.int(n);
  return w.finish();
}
function fields(r: Reader) {
  return Array.from({ length: count(r.int(), 500) }, () => {
    const kind = r.int();
    if (kind !== 1 && kind !== 2) throw new Error('Unknown OZ field kind');
    const type = r.int(), name = r.utf(), nullable = r.bool();
    const expression = kind === 2 ? r.utf() : null; // Data only; never execute it.
    return { kind, type, name, nullable, expression };
  });
}
function value(r: Reader, type: number): string | number | boolean | null {
  if (type === -6 || type === 5) { const n = r.int(); return n === -2147483648 ? null : n; }
  if (type === -7) return r.byte() !== 0;
  if (type === 2 || type === 3) return r.utf() || null;
  if ([91, 92, 93].includes(type)) {
    const n = r.bytes(8).readBigInt64BE();
    return n === -9223372036854775808n ? null : n.toString();
  }
  if ([-2, -3, -4, 2004].includes(type)) {
    const n = r.int();
    return n <= 0 ? null : r.bytes(n).toString('base64');
  }
  if (![1, 12, -1, 2005, 4, -5, 6, 7, 8].includes(type)) throw new Error('Unsupported OZ SQL type');
  if (r.bool()) return null;
  if (type === 4) return r.int();
  if (type === -5) return r.bytes(8).readBigInt64BE().toString();
  if (type === 7) return r.bytes(4).readFloatBE();
  if (type === 6 || type === 8) return r.bytes(8).readDoubleBE();
  return r.utf();
}
export function parseDataModule(buffer: Buffer) {
  const r = new Reader(buffer);
  const h = parseHeader(r);
  if (h.name !== 'oz.framework.cp.message.FrameworkResponseDataModule') throw new Error('Unexpected OZ response');
  const subtype = r.int();
  r.int();
  // OZRA ignores this byte; upstream fixture uses 1, CAU currently sends 2.
  // It does not establish compression support or justify rejecting other values.
  const versionByte = r.byte();
  const version = r.int();
  if (r.utf() !== 'OZBINDEDDATAMODULE') throw new Error('Invalid OZ data module prefix');
  const dataVersion = r.int();
  r.int(); r.int();
  const groups = Array.from({ length: count(r.short(), 100) }, () => {
    const name = r.utf(), format = r.utf();
    if (format !== 'ByteArraySet') throw new Error('Unsupported OZ dataset format');
    const subtype = r.utf();
    const primary = fields(r);
    const secondaryFields = fields(r);
    const datasets = Array.from({ length: count(r.int(), 100) }, () => ({
      size: count(r.int(), MAX_BYTES), rows: count(r.int()), key: r.utf(), records: [] as { length: number; offset: number }[], decodedRows: [] as Record<string, unknown>[],
    }));
    return { name, format, subtype, fields: primary, secondaryFields, datasets };
  });
  const totalSize = count(r.int(), MAX_BYTES);
  for (const group of groups) for (const ds of group.datasets) {
    for (let i = 0; i < ds.rows; i++) ds.records.push({ length: count(r.int(), MAX_BYTES), offset: count(r.int(), MAX_BYTES) });
  }
  const blob = r.bytes(totalSize);
  const datasets: Record<string, Record<string, unknown>[]> = Object.create(null);
  for (const group of groups) {
    if (Object.hasOwn(datasets, group.name)) throw new Error('Duplicate OZ dataset');
    datasets[group.name] = [];
    for (const ds of group.datasets) {
      ds.decodedRows = [];
      for (const record of ds.records) {
        if (record.offset + record.length > blob.length) throw new Error('OZ record outside data blob');
        const rowReader = new Reader(blob.subarray(record.offset, record.offset + record.length));
        const row: Record<string, unknown> = Object.create(null);
        for (const field of group.fields) row[field.name] = value(rowReader, field.type);
        if (rowReader.offset !== record.length) throw new Error('OZ row length mismatch');
        ds.decodedRows.push(row);
        datasets[group.name].push(row);
      }
    }
  }
  // datasets is the convenience group-name view, matching OZRA. groups retains
  // internal dataset keys, schemas, boundaries and separate rows without loss.
  return { meta: { subtype, versionByte, version, dataVersion }, groups, datasets };
}
