import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExamTerms, normalizeExamTerm, parseExamTerm } from '../src/academic-term.js';

test('exam terms normalize regular and seasonal names to four distinct keys', () => {
  const cases: Array<[string, string]> = [
    ['2026-1', '2026-1'], ['2026년 1학기', '2026-1'], ['2026학년도 제1학기', '2026-1'],
    ['2026-2학기', '2026-2'], ['2026학년도 2학기', '2026-2'],
    ['2026-S', '2026-S'], ['2026-s', '2026-S'], ['2026-summer', '2026-S'],
    ['2026-하계 계절학기', '2026-S'], ['2026년 여름 계절학기', '2026-S'],
    ['2025-W', '2025-W'], ['2025_w', '2025-W'], ['2025-winter', '2025-W'],
    ['2025학년도 동계 계절학기', '2025-W'], ['2025 겨울학기', '2025-W'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeExamTerm(input), expected, input);
  assert.deepEqual(parseExamTerm('2025-W'), { year: 2025, semester: 'W', canonical: '2025-W' });
});

test('ambiguous seasons and calendar dates are rejected as exam term input', () => {
  for (const input of ['2026 계절학기', '하계', '2026-3', '2026-10', '2026-01-14', '../2026-S', '2026SOMETHING']) {
    assert.equal(parseExamTerm(input), null, input);
    assert.throws(() => normalizeExamTerm(input), /INVALID_EXAM_TERM/);
  }
});

test('notice term extraction preserves winter academic years and ignores date serials', () => {
  const cases: Array<[string, string[]]> = [
    ['2026학년도 제2학기 중간시험 시간표', ['2026-2']],
    ['2026-하계 계절학기 기말시험 시간표_공지.pdf', ['2026-S']],
    ['2026하계계절학기중간시험유형시간표_공지.pdf', ['2026-S']],
    ['2025-W 기말시험 시간표 (2026-01-14)', ['2025-W']],
    ['2025 동계 계절학기_시험시간표_20260114.pdf', ['2025-W']],
    ['2026-1 시간표(2026-10-03).pdf', ['2026-1']],
    ['2026-10-03, 2026-1-14, 20260114', []],
  ];
  for (const [input, expected] of cases) assert.deepEqual(extractExamTerms(input).map((term) => term.canonical), expected, input);
});
