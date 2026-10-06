import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Reader, parseHeader, parseDataModule, loginRequest, dataRequest } from '../src/oz-protocol.js';

function i32(n: number): Buffer { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function u16(n: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; }
function utf(s: string): Buffer { const b = Buffer.from(s); return Buffer.concat([u16(b.length), b]); }
function wide(s: string): Buffer { return Buffer.concat([i32(s.length), Buffer.from(s, 'utf16le').swap16()]); }

// Small artificial wire sample: one dataset, one nullable VARCHAR column,
// two rows (Korean text and SQL NULL), and explicit row offsets.
function sample(offset = 0, extraRowByte = false, splitDatasets = false): Buffer {
  const row1 = Buffer.concat([Buffer.from([0]), utf('테스트'), ...(extraRowByte ? [Buffer.from([0])] : [])]);
  const row2 = Buffer.from([1]);
  return Buffer.concat([
    i32(10001), wide('oz.framework.cp.message.FrameworkResponseDataModule'), i32(0),
    i32(380), i32(0), Buffer.from([2]), i32(17), utf('OZBINDEDDATAMODULE'),
    i32(2040), i32(0), i32(0), u16(1),
    utf('sample'), utf('ByteArraySet'), utf(''),
    i32(1), i32(1), i32(12), utf('TEXT'), Buffer.from([1]),
    i32(0), ...(splitDatasets
      ? [i32(2), i32(row1.length), i32(1), utf('first'), i32(1), i32(1), utf('second')]
      : [i32(1), i32(row1.length + 1), i32(2), utf('rows')]),
    i32(row1.length + 1),
    i32(row1.length), i32(offset), i32(1), i32(row1.length), row1, row2,
  ]);
}

test('decodes schema, Korean text and SQL NULL using record boundaries', () => {
  const result = parseDataModule(sample());
  assert.deepEqual(result.datasets.sample.map((row: { TEXT: string | null }) => row.TEXT), ['테스트', null]);
});

test('Modified UTF handles Java NUL, surrogate pair and long-length prefix', () => {
  const encoded = Buffer.from([0xc0, 0x80, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]);
  const reader = new Reader(Buffer.concat([u16(65535), i32(encoded.length), encoded]));
  assert.equal(reader.utf(), '\0😀');
});

test('rejects malformed strings and truncated datasets', () => {
  assert.throws(() => new Reader(Buffer.from([0, 1, 0xff])).utf());
  const b = sample();
  assert.throws(() => parseDataModule(b.subarray(0, b.length - 1)), /Truncated/);
});

test('rejects records outside blob and unconsumed row bytes', () => {
  assert.throws(() => parseDataModule(sample(-1)), /size\/count/);
  assert.throws(() => parseDataModule(sample(1000)), /outside/);
  assert.throws(() => parseDataModule(sample(0, true)), /length mismatch/);
});

test('exception wire messages are rejected before treating code as field count', () => {
  const b = Buffer.concat([i32(10001), wide('oz.framework.cp.message.OZCPExceptionMessage'), i32(10101000)]);
  assert.throws(() => parseHeader(new Reader(b)), /server returned an exception/);
});

const fixture = (name: string) => readFileSync(new URL(`./fixtures/oz/${name}`, import.meta.url));
test('accepts OZRA empty response with version byte 1 and preserves schemas/keys', () => {
  const result = parseDataModule(fixture('ozra-empty-v1.bin'));
  assert.equal(result.meta.versionByte, 1);
  assert.equal(result.datasets.EmptyGroup.length, 0);
  assert.equal(result.groups[0].datasets[0].key, 'ds0');
  assert.equal(result.groups[0].fields[0].name, 'NAME');
});
test('CAU compact request bodies match sanitized browser captures byte for byte', () => {
  assert.deepEqual(loginRequest(), fixture('cau-login.bin'));
  assert.deepEqual(dataRequest('fixture-session', {
    sust: '3B410', camp_cd: '1', clss_no: '01', sbjt_no: '15841', emp_no: '', shtm: 'S', year: '2026',
  }), fixture('cau-data.bin'));
});

test('preserves separate datasets inside one group while offering merged rows', () => {
  const result = parseDataModule(sample(0, false, true));
  const sets = result.groups[0].datasets;
  assert.deepEqual(sets.map((ds: { key: string }) => ds.key), ['first', 'second']);
  assert.equal(sets[0].decodedRows[0].TEXT, '테스트');
  assert.equal(sets[1].decodedRows[0].TEXT, null);
  assert.equal(result.datasets.sample.length, 2);
});

function singleValue(type: number, row: Buffer): Buffer {
  return Buffer.concat([
    i32(10001), wide('oz.framework.cp.message.FrameworkResponseDataModule'), i32(0),
    i32(0), i32(0), Buffer.from([1]), i32(17), utf('OZBINDEDDATAMODULE'),
    i32(2040), i32(0), i32(0), u16(1), utf('value'), utf('ByteArraySet'), utf(''),
    i32(1), i32(1), i32(type), utf('V'), Buffer.from([1]), i32(0),
    i32(1), i32(row.length), i32(1), utf('rows'), i32(row.length),
    i32(row.length), i32(0), row,
  ]);
}
test('BIT accepts nonzero byte and binary nonpositive length is SQL NULL', () => {
  assert.equal(parseDataModule(singleValue(-7, Buffer.from([255]))).datasets.value[0].V, true);
  for (const n of [0, -1, -2147483648]) {
    assert.equal(parseDataModule(singleValue(2004, i32(n))).datasets.value[0].V, null);
  }
});
