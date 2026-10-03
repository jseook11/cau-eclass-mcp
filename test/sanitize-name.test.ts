import test from 'node:test';
import assert from 'node:assert/strict';
import { basename, extname } from 'node:path';

import { sanitizeFileName } from '../src/utils.js';

function assertSafeFilename(name: string | null): asserts name is string {
  assert.ok(name, 'a usable filename remains');
  assert.equal(basename(name), name);
  assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]/);
}

test('sanitizeFileName preserves Korean filenames', () => {
  assert.equal(sanitizeFileName('확률통계 3주차.pdf'), '확률통계 3주차.pdf');
  const name = sanitizeFileName('일반물리(1) 기말과제.pdf');
  assertSafeFilename(name);
  assert.match(name, /일반물리/);
  assert.match(name, /1/);
  assert.match(name, /기말과제/);
  assert.equal(extname(name), '.pdf');
});

test('sanitizeFileName keeps distinct Korean names distinct (no overwrite collision)', () => {
  const a = sanitizeFileName('확률통계.pdf');
  const b = sanitizeFileName('선형대수.pdf');
  assert.ok(a && b);
  assert.notEqual(a, b);
});

test('sanitizeFileName blocks path traversal and empty names', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('..'), null);
  assert.equal(sanitizeFileName(''), null);
  assert.equal(sanitizeFileName('a/b/c.txt'), 'c.txt');
});

test('sanitizeFileName removes unsafe characters while preserving the name and extension', () => {
  const name = sanitizeFileName('a<b>:c?.pdf');
  assertSafeFilename(name);
  assert.match(name, /a.*b.*c/);
  assert.equal(extname(name), '.pdf');
});
