import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseExamScheduleTsv } from '../src/tools/exams/pdf-parser.js';

function word(x: number, y: number, text: string, width = 8, page = 1): string {
  return `5\t${page}\t0\t0\t0\t0\t${x}\t${y}\t${width}\t5\t100\t${text}`;
}
function parse(words: string[], term = '2026-1') {
  return parseExamScheduleTsv([
    'level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    ...words,
  ].join('\n'), { term, exam_type: 'final' });
}

test('generic parser distinguishes online and in-person methods', () => {
  for (const [method, expected] of [
    ['온라인(비대면)시험', '온라인시험'], ['온라인시험', '온라인시험'],
    ['비대면시험', '온라인시험'], ['대면시험', '대면시험'],
  ]) {
    const result = parse([word(20, 80, '54288'), word(60, 80, '01'), word(120, 80, '과목A'), word(400, 80, method)]);
    assert.ok(result.ok);
    assert.equal(result.schedules[0].exam_method, expected);
  }
});

test('generic parser does not turn notice deadlines into course schedules', () => {
  assert.equal(parse([word(20, 40, '시험 안내'), word(20, 80, '제출기한'),
    word(100, 80, '2026-06-19'), word(200, 80, '18:00')]).ok, false);
});

test('generic parser distinguishes a winter date from a declared row term', () => {
  const row = [word(20, 80, '54288'), word(60, 80, '01'), word(120, 80, '계절과목'),
    word(400, 80, '대면시험'), word(500, 80, '2026-1-14')];
  const result = parse(row, '2025-W');
  assert.ok(result.ok);
  assert.equal(result.schedules[0].exam_date, '2026-01-14');
  assert.equal(parse([word(0, 80, '2026 1'), ...row], '2025-W').ok, false);
});

test('generic parser preserves actual BNE names, instructors and exam fields', () => {
  const source = fs.readFileSync(new URL('./fixtures/exam-bne-generic-final-2026-1.tsv', import.meta.url), 'utf8');
  const result = parseExamScheduleTsv(source, { term: '2026-1', exam_type: 'final' });
  assert.ok(result.ok);
  assert.equal(result.schedules.length, 16);
  const find = (code: string) => result.schedules.find(row => row.course_code === code)!;
  assert.equal(find('54288').course_name, '벤처창업 경영론');
  assert.equal(find('54262').course_name, '암호와 인증');
  assert.equal(find('54290').course_name, '소자본 서비스 창업과 인적자원관리(종합설계)');
  assert.equal(find('58718').course_name, '안전한인공지능');
  assert.equal(find('58718').instructor, '김호기');
  assert.equal(find('58718').lecture_time, '화(16:30~17:45) / 목(16:30~17:45)');
  assert.equal(find('58718').start_time, '16:30');
  assert.equal(find('58718').end_time, '17:50');
  assert.equal(find('58718').building, '310');
  assert.equal(find('58718').rooms, '721');
  assert.equal(find('40150').course_name, '파생상품');
  assert.equal(find('40150').instructor, '유시용');
  assert.equal(find('54262').start_time, '12:00');
  assert.equal(find('54262').end_time, '13:00');
  assert.equal(find('54262').rooms, '932');
  const continuation = result.schedules.find(row => row.course_code === '35705' && row.section === '08')!;
  assert.equal(continuation.course_name, '회계학원론');
  assert.equal(continuation.instructor, '하원석');
  assert.equal(continuation.start_time, '10:30');
  assert.equal(continuation.rooms, '703 704');
  assert.equal(find('35706').exam_method, '온라인시험');
});

test('generic header inference preserves fields under print scaling and translation', () => {
  const source = fs.readFileSync(new URL('./fixtures/exam-bne-generic-final-2026-1.tsv', import.meta.url), 'utf8');
  const baseline = parseExamScheduleTsv(source, { term: '2026-1', exam_type: 'final' });
  assert.ok(baseline.ok);
  for (const scale of [0.5, 1.5]) {
    const shifted = source.trim().split('\n').map((line, i) => {
      if (i === 0) return line;
      const cells = line.split('\t');
      cells[6] = String(Number(cells[6]) * scale + 75);
      for (const index of [7, 8, 9]) cells[index] = String(Number(cells[index]) * scale);
      return cells.join('\t');
    }).join('\n');
    const result = parseExamScheduleTsv(shifted, { term: '2026-1', exam_type: 'final' });
    assert.ok(result.ok);
    // Typography changes spacing, but must not move text into another field.
    const fields = (rows: typeof result.schedules) => rows.map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === 'string' ? value.replace(/\s+/g, '') : value]),
    ));
    assert.deepEqual(fields(result.schedules), fields(baseline.schedules));
  }
});

test('empty exam time columns do not inherit lecture times', () => {
  const result = parse([
    word(20, 40, '교과목코드'), word(80, 40, '분반'), word(140, 40, '교과목명'),
    word(250, 40, '강의시간'), word(400, 40, '시험유형'), word(500, 40, '시작시간'), word(600, 40, '종료시간'),
    word(700, 40, '건물번호'), word(800, 40, '고사실'),
    word(20, 80, '54288'), word(80, 80, '01'), word(140, 80, '교과A'),
    word(250, 80, '월(09:00~10:00)'), word(400, 80, '과제물대체'), word(700, 80, '.'), word(800, 80, '-'),
  ]);
  assert.ok(result.ok);
  assert.equal(result.schedules[0].start_time, null);
  assert.equal(result.schedules[0].end_time, null);
  assert.equal(result.schedules[0].building, null);
  assert.equal(result.schedules[0].rooms, null);
});

test('generic headers are inferred separately on pages with different column positions', () => {
  const words: string[] = [];
  for (const [page, shift] of [[1, 0], [2, 100]]) {
    for (const [x, label] of [[20, '교과목코드'], [80, '분반'], [140, '교과목명'], [250, '교수명'], [400, '시험유형']]) {
      words.push(word(Number(x) + shift, 40, String(label), 8, page));
    }
    for (const [x, label] of [[20, String(54288 + page)], [80, '01'], [140, `교과${page}`], [250, `교수${page}`], [400, '대면시험']]) {
      words.push(word(Number(x) + shift, 80, String(label), 8, page));
    }
  }
  const result = parse(words);
  assert.ok(result.ok);
  assert.deepEqual(result.schedules.map(row => [row.course_name, row.instructor]), [['교과1', '교수1'], ['교과2', '교수2']]);
});

test('grid parser dumps one record per date row', () => {
  const words = [
    word(100, 40, '1'), word(200, 40, '2'),
    word(100, 60, '09:00'), word(130, 60, '~'), word(140, 60, '10:00'),
    word(200, 60, '10:00'), word(230, 60, '~'), word(240, 60, '11:00'),
    word(20, 130, '6/19'), word(100, 130, '과목A'), word(200, 130, '과목B'),
  ];
  const result = parse(words);
  assert.ok(result.ok);
  assert.equal(result.layout, 'grid');
  // A grid is dumped per date band (the cell layout is not normalized).
  assert.equal(result.schedules.length, 1);
  assert.equal(result.schedules[0].exam_date, '2026-06-19');
  assert.match(result.schedules[0].raw_text ?? '', /과목A/);
  assert.match(result.schedules[0].raw_text ?? '', /과목B/);
});

test('grid dates and pages remain separate and room notes are captured', () => {
  const words: string[] = [];
  for (const page of [1, 2]) {
    words.push(word(100, 40, '1', 8, page), word(200, 40, '2', 8, page),
      word(100, 60, '09:00', 8, page), word(130, 60, '~', 8, page), word(140, 60, '10:00', 8, page),
      word(200, 60, '10:00', 8, page), word(230, 60, '~', 8, page), word(240, 60, '11:00', 8, page),
      word(20, 130, '6/19', 8, page), word(100, 130, `교과${page}(실습)`, 40, page),
      word(100, 150, '시험 장소: 310호', 40, page),
      word(20, 230, '6/20', 8, page), word(200, 230, `영어${page}`, 8, page));
  }
  const result = parse(words);
  assert.ok(result.ok);
  assert.deepEqual(result.schedules.map(row => [row.exam_date, row.rooms]), [
    ['2026-06-19', '310호'], ['2026-06-20', null], ['2026-06-19', '310호'], ['2026-06-20', null],
  ]);
  assert.match(result.schedules[0].raw_text ?? '', /교과1\(실습\)/);
});
