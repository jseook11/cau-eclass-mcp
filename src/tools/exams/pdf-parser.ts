import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExamScheduleRecord } from '../../exam-cache.js';
import { normalizeExamTerm, parseExamTerm } from '../../academic-term.js';

const execFileAsync = promisify(execFile);

interface TsvWord {
  page_num: number;
  left: number;
  top: number;
  width: number;
  text: string;
}

type PdfLayout = 'general_education' | 'software_college' | 'business_economics' | 'grid' | 'generic';

export type ParseExamPdfResult = {
  ok: true;
  parser: 'pdftotext-tsv';
  layout: PdfLayout;
  schedules: Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[];
} | {
  ok: false;
  error_code: 'EXAM_PARSER_UNAVAILABLE' | 'EXAM_PARSER_UNSUPPORTED' | 'EXAM_PARSER_FAILED';
  message: string;
  retryable: boolean;
  next_action?: string;
  debug?: string;
};

function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parsePdftotextTsv(tsv: string): TsvWord[] {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = lines[0].split('\t');
  const idx = (name: string): number => header.indexOf(name);
  const pageIdx = idx('page_num');
  const leftIdx = idx('left');
  const topIdx = idx('top');
  const widthIdx = idx('width');
  const textIdx = idx('text');
  if ([pageIdx, leftIdx, topIdx, widthIdx, textIdx].some((i) => i < 0)) return [];

  const words: TsvWord[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const text = cols[textIdx];
    if (!text || text.startsWith('###')) continue;
    words.push({
      page_num: parseNumber(cols[pageIdx]),
      left: parseNumber(cols[leftIdx]),
      top: parseNumber(cols[topIdx]),
      width: parseNumber(cols[widthIdx]),
      text,
    });
  }
  return words;
}

function detectLayout(words: TsvWord[]): PdfLayout | null {
  const joined = [...words].sort((a, b) => a.page_num - b.page_num || a.top - b.top || a.left - b.left)
    .slice(0, 200).map((w) => w.text).join(' ');
  if (joined.includes('교과목코드') && joined.includes('개설대학명')) return 'business_economics';
  if (joined.includes('소프트웨어') || (joined.includes('교과목') && joined.includes('코드'))) {
    return 'software_college';
  }
  if (joined.includes('교양대학') || /(?:중간|기말)시험 유형/.test(joined) || joined.includes('교과목명')) {
    return 'general_education';
  }
  return null;
}

function normalizeCell(words: TsvWord[]): string | null {
  const sorted = groupVisualLines(words).flat();
  if (sorted.length === 0) return null;
  let output = '';
  let prev: TsvWord | null = null;
  for (const word of sorted) {
    if (!prev) {
      output = word.text;
    } else {
      const gap = word.left - (prev.left + prev.width);
      const needsSpace = Math.abs(word.top - prev.top) > 2.2 || gap > 3 || /[A-Za-z0-9)]$/.test(prev.text) || /^[A-Za-z0-9(]/.test(word.text);
      output += needsSpace ? ` ${word.text}` : word.text;
    }
    prev = word;
  }
  return output.replace(/\s+/g, ' ').trim() || null;
}

function wordsInRange(words: TsvWord[], minX: number, maxX: number): TsvWord[] {
  return words.filter((w) => w.left >= minX && w.left < maxX);
}

function groupVisualLines(words: TsvWord[]): TsvWord[][] {
  const lines: TsvWord[][] = [];
  const byPage = new Map<number, TsvWord[]>();
  for (const word of words) {
    const pageWords = byPage.get(word.page_num) ?? [];
    pageWords.push(word);
    byPage.set(word.page_num, pageWords);
  }

  for (const pageWords of byPage.values()) {
    const sorted = [...pageWords].sort((a, b) => a.top - b.top || a.left - b.left);
    for (const word of sorted) {
      const existing = lines.find((line) =>
        line[0].page_num === word.page_num && Math.abs(line[0].top - word.top) <= 2.2,
      );
      if (existing) existing.push(word);
      else lines.push([word]);
    }
  }
  return lines.map((line) => line.sort((a, b) => a.left - b.left));
}

function groupAnchoredRows(words: TsvWord[], isAnchor: (word: TsvWord) => boolean): TsvWord[][] {
  const byPage = new Map<number, TsvWord[]>();
  for (const word of words) {
    const page = byPage.get(word.page_num) ?? [];
    page.push(word);
    byPage.set(word.page_num, page);
  }
  const rows: TsvWord[][] = [];
  for (const page of byPage.values()) {
    const anchors = page.filter(isAnchor)
      .sort((a, b) => a.top - b.top);
    // 고정된 열을 행의 중심으로 삼아 줄바꿈과 글꼴별 높이 차이를 함께 처리한다.
    for (let i = 0; i < anchors.length; i++) {
      const anchor = anchors[i];
      const previous = anchors[i - 1]?.top ?? anchor.top - (anchors[i + 1]?.top - anchor.top || 20);
      const next = anchors[i + 1]?.top ?? anchor.top + (anchor.top - previous);
      rows.push(page.filter((word) => word.top >= (previous + anchor.top) / 2 && word.top < (anchor.top + next) / 2));
    }
  }
  return rows;
}

function toIsoDate(value: string | null, term?: string): string | null {
  if (!value) return null;
  const match = /(\d{4})[-.](\d{1,2})[-.](\d{1,2})/.exec(value);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const koreanDate = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(value);
  if (koreanDate) {
    const academicTerm = term ? parseExamTerm(term) : null;
    if (!academicTerm) return null;
    const month = Number(koreanDate[1]);
    const year = academicTerm.year + (academicTerm.semester === 'W' && month <= 2 ? 1 : 0);
    return `${year}-${koreanDate[1].padStart(2, '0')}-${koreanDate[2].padStart(2, '0')}`;
  }
  const shortDate = /^(\d{1,2})\/(\d{1,2})(?:\([월화수목금토일]\))?$/.exec(value.replace(/\s+/g, ''));
  const academicTerm = term ? parseExamTerm(term) : null;
  if (!shortDate || !academicTerm) return null;
  const month = Number(shortDate[1]);
  const year = academicTerm.year + (academicTerm.semester === 'W' && month <= 2 ? 1 : 0);
  return `${year}-${shortDate[1].padStart(2, '0')}-${shortDate[2].padStart(2, '0')}`;
}

function toTime(value: string | null): string | null {
  if (!value) return null;
  const match = /(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function isExamMethod(value: string | null): boolean {
  return !!value && /(대면시험|온라인|과제물대체|미실시|기타)/.test(value);
}

function parseSoftwareLine(
  line: TsvWord[],
  term: string,
  examType: string,
  compact: boolean,
  landscape: boolean,
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'> | null {
  // 중간시험의 축소 인쇄본과 기존 기말시험 PDF는 열 경계가 다르다.
  const columns = landscape
    ? [18, 42, 70, 184, 262, 300, 331, 399, 451, 501, 551, 604, 756, 835]
    : compact
    ? [53, 77, 92, 162, 202, 230, 251, 289, 325, 357, 389, 419, 518, 560]
    : [20, 52, 78, 145, 185, 220, 240, 286, 322, 356, 390, 420, 540, 595];
  const cell = (index: number): string | null => normalizeCell(wordsInRange(line, columns[index], columns[index + 1]));
  const courseCode = cell(0);
  const section = cell(1);
  const courseName = cell(2);
  if (!courseCode || !/^\d{4,6}$/.test(courseCode) || !section || !courseName) return null;

  const lectureTime = cell(3);
  const instructor = cell(4);
  const examMethod = cell(6);
  if (!isExamMethod(examMethod)) return null;

  const examDate = toIsoDate(cell(7), term);
  const startTime = toTime(cell(8));
  const endTime = toTime(cell(9));
  const building = cell(10);
  const rooms = cell(11);
  const note = cell(12);

  return {
    term,
    exam_type: examType,
    course_code: courseCode,
    course_name: courseName,
    section,
    lecture_time: lectureTime,
    instructor,
    exam_method: examMethod,
    exam_date: examDate,
    start_time: startTime,
    end_time: endTime,
    building,
    rooms,
    note,
    raw_text: normalizeCell(line),
  };
}

function parseGeneralEducationCombinedLine(
  line: TsvWord[],
  term: string,
  examType: string,
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'> | null {
  const courseName = normalizeCell(wordsInRange(line, 56, 282));
  const section = normalizeCell(wordsInRange(line, 282, 315));
  const instructor = normalizeCell(wordsInRange(line, 315, 381));
  const lectureTime = normalizeCell(wordsInRange(line, 381, 461));
  const examMethod = normalizeCell(wordsInRange(line, 461, 573));
  if (!courseName || !section || !/^[A-Z0-9]{2,3}$/i.test(section) || !isExamMethod(examMethod)) return null;

  const dateText = normalizeCell(wordsInRange(line, 573, 645));
  const examDate = toIsoDate(dateText, term);
  const timeText = normalizeCell(wordsInRange(line, 645, 744));
  const times = timeText?.match(/^(\d{1,2}:\d{2})\s*[~～-]\s*(\d{1,2}:\d{2})$/);
  const roomText = normalizeCell(wordsInRange(line, 744, 842));
  const room = roomText && /^(\d{3})\s*-\s*(.+)$/.exec(roomText);
  const notes = [
    dateText && !examDate ? `시험 날짜: ${dateText}` : null,
    timeText && !times ? `시험 시간: ${timeText}` : null,
    roomText && !room ? `시험 강의실: ${roomText}` : null,
  ].filter(Boolean);

  return {
    term, exam_type: examType, course_code: null, course_name: courseName, section,
    lecture_time: lectureTime, instructor, exam_method: examMethod,
    exam_date: examDate, start_time: times ? toTime(times[1]) : null, end_time: times ? toTime(times[2]) : null,
    building: room ? room[1] : null, rooms: room ? room[2] : roomText,
    note: notes.join('; ') || null, raw_text: normalizeCell(line),
  };
}

function parseGeneralEducationLine(
  line: TsvWord[],
  term: string,
  examType: string,
  variant: 'legacy' | 'campus_midterm' | 'campus_final' = 'legacy',
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'> | null {
  const columns = variant === 'campus_midterm'
    ? [53, 220, 256, 308, 386, 484, 558, 633, 684, 731, 778, 842]
    : variant === 'campus_final'
      ? [45, 164, 200, 276, 334, 446, 499, 586, 655, 724, 770, 842]
      : [0, 160, 190, 275, 365, 475, 560, 635, 705, 760, 842];
  const cell = (index: number): string | null => normalizeCell(wordsInRange(line, columns[index], columns[index + 1]));
  const courseName = cell(0);
  const section = cell(1);
  const lectureTime = cell(variant === 'campus_midterm' ? 3 : 2);
  const instructor = cell(variant === 'campus_midterm' ? 2 : 3);
  const examMethod = cell(4);
  if (!courseName || !section || !/^[A-Z0-9]{2,3}$/i.test(section) || !isExamMethod(examMethod)) return null;

  const dateIndex = variant === 'legacy' ? 5 : 6;
  const dateText = cell(dateIndex);
  const examDate = toIsoDate(dateText, term);
  const notes = [variant === 'legacy' ? null : cell(5)];
  if ((dateText?.match(/\d{4}[-.]\d{1,2}[-.]\d{1,2}/g)?.length ?? 0) > 1) notes.push(`시험 일자: ${dateText}`);
  const startTime = toTime(cell(dateIndex + 1));
  const endTime = toTime(cell(dateIndex + 2));
  const building = cell(dateIndex + 3);
  const rooms = cell(dateIndex + 4);

  return {
    term,
    exam_type: examType,
    course_code: null,
    course_name: courseName,
    section,
    lecture_time: lectureTime,
    instructor,
    exam_method: examMethod,
    exam_date: examDate,
    start_time: startTime,
    end_time: endTime,
    building,
    rooms,
    note: notes.filter(Boolean).join('; ') || null,
    raw_text: normalizeCell(line),
  };
}

function parseBusinessEconomicsLine(
  line: TsvWord[],
  term: string,
  examType: string,
  hasCredits: boolean,
  compactCredits: boolean,
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'> | null {
  const rowYear = normalizeCell(wordsInRange(line, 50, 73));
  const rowSemester = normalizeCell(wordsInRange(line, 73, 90));
  if (!rowYear || !rowSemester || parseExamTerm(`${rowYear}-${rowSemester}`)?.canonical !== term) return null;

  // 학점 열 유무와 인쇄 배율에 따라 공식 출력본의 열 경계가 다르다.
  const columns = compactCredits
    ? [88, 124, 142, 226, 500, 636, 662, 778, 833, 860, 893, 932, 962, 991, 1020, 1111, 1140]
    : hasCredits
    ? [90, 128, 147, 238, 531, 676, 704, 770, 824, 850, 879, 920, 951, 982, 1014, 1111, 1140]
    : [94, 134, 153, 213, 509, 664, 691, 811, 887, 919, 954, 991, 1024, 1057, 1090, 1125, 1140];
  const cell = (index: number): string | null => normalizeCell(wordsInRange(line, columns[index], columns[index + 1]));
  const courseCode = cell(0);
  const section = cell(1);
  const courseName = cell(2);
  const examMethod = cell(7);
  if (!courseCode || !/^\d{4,6}$/.test(courseCode) || !section || !courseName || !isExamMethod(examMethod)) return null;
  const examDate = toIsoDate(cell(10), term);
  const notes = [cell(9), cell(15)].filter(Boolean);
  const academicTerm = parseExamTerm(term)!;
  if (examDate) {
    const expectedYear = academicTerm.year + (academicTerm.semester === 'W' && Number(examDate.slice(5, 7)) <= 2 ? 1 : 0);
    if (Number(examDate.slice(0, 4)) !== expectedYear) notes.push(`원문 시험 날짜 확인 필요: ${examDate} (${term})`);
  }
  return {
    term, exam_type: examType, course_code: courseCode, course_name: courseName, section,
    lecture_time: cell(4), instructor: cell(5), exam_method: examMethod,
    exam_date: examDate, start_time: toTime(cell(11)), end_time: toTime(cell(12)),
    building: cell(13), rooms: cell(14), note: notes.join('; ') || null, raw_text: normalizeCell(line),
  };
}

// --- Layout-agnostic extraction -------------------------------------------------
// Unknown layouts (other colleges, new print variants) are not rejected: rows are
// segmented generically and dumped with best-effort fields plus the full raw text.
// Field names come from content patterns, never from fixed column coordinates.
const GENERIC_METHOD = /(?:\d\.\s*)?(온라인\s*(?:\(\s*비대면\s*\))?\s*시험|비대면\s*시험|대면\s*시험|과제물\s*대체|미실시|기타)/;
const GENERIC_DATE = /\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\/\d{1,2}/;
const GENERIC_TIME = /\b\d{1,2}:\d{2}\b/g;
const GENERIC_CODE = /(?<!\d)\d{5}(?!\d)/;
// A row may declare its own term (e.g. business tables: "2026 1 <code> ...").
const GENERIC_TERM = /^\s*(20\d{2})\s*[- ]\s*([12SW])\b(?![-./]\d)/;
const GENERIC_LECTURE_TIME = /(?:^|[\s/])[월화수목금토일]\s*\(?\d/;
const GENERIC_CELL_GAP = 4;
// Meta labels that are not course names, so a code-less row is not mistaken for a
// course (e.g. a bare notice line) when the name falls back to cell heuristics.
const GENERIC_NON_COURSE = /안내|제출\s*기한|공지|문의|유의|붙임|첨부|지도\s*교수|확인\s*방법|시간표|작성|기재|예시|삭제|양식|e-?class|포탈|로그인|바로가기|http/i;
const GENERIC_HEADER_TOKENS = [
  '교과목코드', '분반', '교과목명', '강의시간', '교수명', '시험실시방법', '중간시험', '기말시험',
  '시험유형', '시험 유형', '시험일자', '시험 일자', '시작시간', '종료시간', '건물번호', '고사실',
  '비고', '연번', '개설대학명', '개설학과명', '개설전공명', '이수구분', '강의실', '수강인원', '캠퍼스', '학점', '건물번',
];

function isGenericHeaderLine(text: string): boolean {
  const hits = GENERIC_HEADER_TOKENS.filter((token) => text.includes(token)).length;
  return hits >= 2 || /유의사항|양식\s*및|Description|상세\s*작성/.test(text);
}

function splitGenericCells(line: TsvWord[]): string[] {
  const cells: string[] = [];
  let current: TsvWord[] = [];
  let previousRight: number | null = null;
  for (const word of line) {
    if (previousRight !== null && word.left - previousRight > GENERIC_CELL_GAP) {
      const cell = normalizeCell(current);
      if (cell) cells.push(cell);
      current = [word];
    } else {
      current.push(word);
    }
    previousRight = word.left + word.width;
  }
  const cell = normalizeCell(current);
  if (cell) cells.push(cell);
  return cells;
}

function normalizeGenericMethod(value: string | undefined): string | null {
  if (!value) return null;
  if (/온라인|비대면/.test(value)) return '온라인시험';
  if (/대면/.test(value)) return '대면시험';
  if (/과제물/.test(value)) return '과제물대체';
  if (/미실시/.test(value)) return '미실시';
  if (/기타/.test(value)) return '기타';
  return value;
}

interface HeaderBound { key: string; lo: number; hi: number; }

const HEADER_KEY_PATTERNS: Array<[RegExp, string]> = [
  [/교과목\s*코드/, 'code'],
  [/분반/, 'section'],
  [/교과목\s*명/, 'name'],
  [/강의시간/, 'lecture_time'],
  [/교수명/, 'instructor'],
  [/시작시간/, 'start'],
  [/종료시간/, 'end'],
  [/건물\s*번/, 'building'],
  [/고사실/, 'rooms'],
  [/비고/, 'note'],
  [/시험\s*(?:실시\s*방법|유형)/, 'method'],
  [/시험\s*일자|시험일/, 'date'],
];

function headerKeyFor(label: string): string | null {
  for (const [pattern, key] of HEADER_KEY_PATTERNS) if (pattern.test(label)) return key;
  return null;
}

function headerLabel(words: TsvWord[]): string {
  return words.slice().sort((a, b) => a.top - b.top || a.left - b.left).map((word) => word.text).join('');
}

// Merge the (often multi-line) header row into column boundaries keyed by field,
// so typed fields come from the header's meaning rather than fixed coordinates.
function detectHeaderBounds(words: TsvWord[]): HeaderBound[] {
  const lines = groupVisualLines(words);
  let index = -1;
  let best = 0;
  lines.forEach((line, i) => {
    const text = normalizeCell(line) ?? '';
    const hits = GENERIC_HEADER_TOKENS.filter((token) => text.includes(token)).length;
    if (hits > best) { best = hits; index = i; }
  });
  if (index < 0 || best < 3) return [];
  const top = lines[index][0].top;
  const page = lines[index][0].page_num;
  const tokens: TsvWord[] = [];
  for (const line of lines) {
    if (line[0].page_num !== page || Math.abs(line[0].top - top) > 80) continue;
    const text = normalizeCell(line) ?? '';
    const hits = GENERIC_HEADER_TOKENS.filter((token) => text.includes(token)).length;
    // Header labels may be stacked over several lines; exclude note/template rows
    // (which carry example dates/times) and real data rows.
    const dataLike = /\d{5}|\d{1,2}:\d{2}|\d{4}[-.]\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일/.test(text);
    if (hits < 1 || dataLike) continue;
    tokens.push(...line);
  }
  const sorted = [...tokens].sort((a, b) => a.left - b.left);
  const clusters: Array<{ start: number; right: number; words: TsvWord[] }> = [];
  for (const word of sorted) {
    const last = clusters[clusters.length - 1];
    const completesLabel = last && !headerKeyFor(headerLabel(last.words))
      && headerKeyFor(headerLabel([...last.words, word]))
      && word.left - last.right <= word.width / Math.max(word.text.length, 1) * 2;
    if (last && (word.left <= last.right || completesLabel)) {
      last.words.push(word);
      last.right = Math.max(last.right, word.left + word.width);
    } else clusters.push({ start: word.left, right: word.left + word.width, words: [word] });
  }
  // Centered labels and left-aligned values have different starting positions.
  // Choose vertical whitespace observed in body rows between header centers,
  // rather than bisecting the labels' left coordinates.
  const bodyLines = lines.filter(line => line[0].page_num === page && line[0].top > top
    && line.some(word => /^\d{4,6}$/.test(word.text)) && !isGenericHeaderLine(normalizeCell(line) ?? ''));
  const body = bodyLines.flat();
  const edges = clusters.slice(1).map((cluster, i) => {
    const previous = clusters[i];
    const lo = (previous.start + previous.right) / 2;
    const hi = (cluster.start + cluster.right) / 2;
    const middle = (lo + hi) / 2;
    // Right-aligned numbers can begin to the right of the header center.
    const starts = [...new Set(body.map(word => word.left))].filter(x => x > lo && x <= cluster.right);
    const glyphWidths = body.map(word => word.width / Math.max(word.text.length, 1)).sort((a, b) => a - b);
    const tolerance = (glyphWidths[Math.floor(glyphWidths.length / 2)] ?? 0);
    const repeatedStarts = starts.map(x => ({ x, support: bodyLines.filter(line =>
      line.some(word => Math.abs(word.left - x) <= tolerance)).length }))
      .filter(candidate => candidate.support > bodyLines.length / 2)
      .sort((a, b) => b.support - a.support || Math.abs(a.x - hi) - Math.abs(b.x - hi));
    if (repeatedStarts.length) {
      const start = repeatedStarts[0].x;
      const ends = body.map(word => word.left + word.width).filter(x => x < start && x >= lo);
      return ends.length ? (Math.max(...ends) + start) / 2 : (lo + start) / 2;
    }
    const positions = [...new Set([lo, hi, ...body.flatMap(word => [word.left, word.left + word.width])])]
      .filter(x => x >= lo && x <= hi).sort((a, b) => a - b);
    const candidates = [middle, ...positions.slice(1).map((x, j) => (positions[j] + x) / 2)];
    return candidates.map(x => ({ x, crossings: body.filter(word => word.left < x && word.left + word.width > x).length }))
      .sort((a, b) => a.crossings - b.crossings || Math.abs(a.x - middle) - Math.abs(b.x - middle))[0].x;
  });
  const bounds = clusters.map((cluster, i) => ({
    key: headerKeyFor(headerLabel(cluster.words)),
    lo: i === 0 ? -Infinity : edges[i - 1],
    hi: i === clusters.length - 1 ? Infinity : edges[i],
  }));
  return bounds.filter((bound): bound is HeaderBound => bound.key !== null);
}

function cellsByHeader(line: TsvWord[], bounds: HeaderBound[]): Map<string, TsvWord[]> {
  const cells = new Map<string, TsvWord[]>();
  for (const word of line) {
    const bound = bounds.find((candidate) => word.left >= candidate.lo && word.left < candidate.hi);
    if (!bound) continue;
    const words = cells.get(bound.key) ?? [];
    words.push(word);
    cells.set(bound.key, words);
  }
  return cells;
}

function parseGenericLine(
  line: TsvWord[],
  term: string,
  examType: string,
  bounds: HeaderBound[],
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'> | null {
  const rawText = normalizeCell(line);
  if (!rawText) return null;
  const cells = splitGenericCells(line);
  const headerCells = bounds.length > 0 ? cellsByHeader(line, bounds) : undefined;
  const fromHeader = (key: string): string | null => {
    const words = headerCells?.get(key);
    const value = words && words.length > 0 ? normalizeCell(words) : null;
    return value && !/^[-–—.]+$/.test(value) ? value : null;
  };

  const codeCell = cells.find((cell) => /^\d{5}$/.test(cell));
  const headerCode = fromHeader('code');
  const courseCode = (headerCode && /^\d{4,6}$/.test(headerCode) ? headerCode : null)
    ?? codeCell ?? rawText.match(GENERIC_CODE)?.[0] ?? null;

  const headerSection = fromHeader('section');
  const section = (headerSection && /^\d{1,3}$/.test(headerSection) ? headerSection : null) ?? (() => {
    const index = codeCell ? cells.indexOf(codeCell) : -1;
    const rest = index >= 0 ? cells.slice(index + 1) : cells;
    return rest.find((cell) => /^\d{1,2}$/.test(cell)) ?? null;
  })();

  const lectureHeader = fromHeader('lecture_time');
  const headerName = fromHeader('name');
  const heuristicName = cells
    .filter((cell) => cell.trim().length >= 3
      && /[가-힣A-Za-z]/.test(cell)
      && !/^\d+$/.test(cell)
      && !GENERIC_DATE.test(cell)
      && !/\d{1,2}:\d{2}/.test(cell)
      && !GENERIC_METHOD.test(cell)
      && !GENERIC_NON_COURSE.test(cell)
      && cell !== lectureHeader
      && !GENERIC_HEADER_TOKENS.includes(cell))
    .sort((a, b) => b.length - a.length)[0] ?? null;
  // Prefer the mapped name column, but fall back to the longest course-like cell:
  // documents without a code column or with an unfamiliar header still need a name.
  const courseName = (headerName && /[가-힣A-Za-z]/.test(headerName) ? headerName : null) ?? heuristicName;

  const headerMethod = fromHeader('method');
  const examMethod = normalizeGenericMethod(
    (headerMethod && GENERIC_METHOD.test(headerMethod) ? headerMethod : null)
      ?? cells.find((cell) => GENERIC_METHOD.test(cell))
      ?? rawText.match(GENERIC_METHOD)?.[0],
  );
  const headerDate = fromHeader('date');
  const examDate = toIsoDate(
    (headerDate && GENERIC_DATE.test(headerDate) ? headerDate : null) ?? rawText.match(GENERIC_DATE)?.[0] ?? null,
    term,
  );
  const times = rawText.match(GENERIC_TIME) ?? [];
  const lectureTime = (lectureHeader && GENERIC_LECTURE_TIME.test(lectureHeader) ? lectureHeader : null)
    ?? cells.find((cell) => GENERIC_LECTURE_TIME.test(cell) && cell.length <= 24) ?? null;

  if (!courseCode && !courseName) return null;
  return {
    term,
    exam_type: examType,
    course_code: courseCode,
    course_name: courseName ?? '',
    section,
    lecture_time: lectureTime,
    instructor: fromHeader('instructor'),
    exam_method: examMethod,
    exam_date: examDate,
    start_time: toTime(bounds.some(bound => bound.key === 'start') ? fromHeader('start') : times[0] ?? null),
    end_time: toTime(bounds.some(bound => bound.key === 'end') ? fromHeader('end') : times[1] ?? null),
    building: fromHeader('building'),
    rooms: fromHeader('rooms') ?? cells.find((cell) => /^\d{3,4}(?:[-,~]\s*\d{3,4})*\s*호?$/.test(cell.trim())) ?? null,
    note: fromHeader('note'),
    raw_text: rawText,
  };
}

// A course-code column is the most reliable row anchor: a new logical row starts
// only where the code column holds a 5-digit code, so wrapped continuation lines
// (which start with stray digits) do not split a row.
function findCodeColumn(words: TsvWord[]): { minX: number; maxX: number } | null {
  const codes = words.filter((word) => /^\d{5}$/.test(word.text));
  if (codes.length < 2) return null;
  const minX = Math.min(...codes.map((word) => word.left));
  const maxX = Math.max(...codes.map((word) => word.left + word.width));
  // A real column is narrow; a wide spread means these are not a code column.
  if (maxX - minX > 120) return null;
  return { minX: minX - 2, maxX: maxX + 2 };
}

function parseGenericRows(
  words: TsvWord[],
  term: string,
  examType: string,
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[] {
  const pages = new Map<number, TsvWord[]>();
  for (const word of words) {
    const page = pages.get(word.page_num) ?? [];
    page.push(word);
    pages.set(word.page_num, page);
  }
  const schedules: Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[] = [];
  let headerBounds: HeaderBound[] = [];
  for (const page of pages.values()) {
    const detected = detectHeaderBounds(page);
    if (detected.length) headerBounds = detected;
    schedules.push(...parseGenericPageRows(page, term, examType, headerBounds));
  }
  return schedules;
}

function parseGenericPageRows(
  words: TsvWord[],
  term: string,
  examType: string,
  headerBounds: HeaderBound[],
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[] {
  const codeColumn = findCodeColumn(words);
  const startsRow = (line: TsvWord[]): boolean => {
    if (codeColumn) {
      return line.some((word) =>
        word.left >= codeColumn.minX && word.left < codeColumn.maxX && /^\d{5}$/.test(word.text));
    }
    const first = line[0]?.text ?? '';
    return /^\d+$/.test(first) || /^(서울|다빈치|안성)/.test(first);
  };

  const rows: TsvWord[][] = [];
  let current: TsvWord[] | null = null;
  for (const line of groupVisualLines(words)) {
    const text = normalizeCell(line);
    if (!text || isGenericHeaderLine(text)) continue;
    if (current === null || startsRow(line)) {
      if (current) rows.push(current);
      current = [...line];
    } else {
      current = current.concat(line);
    }
  }
  if (current) rows.push(current);

  const schedules: Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[] = [];
  const expectedTerm = parseExamTerm(term)?.canonical;
  for (const row of rows) {
    // When a row states its own term, honor it so a different term's document is
    // not reported as this term's schedule.
    if (expectedTerm) {
      const declared = GENERIC_TERM.exec(normalizeCell(row) ?? '');
      const declaredTerm = declared ? parseExamTerm(`${declared[1]}-${declared[2]}`)?.canonical : undefined;
      if (declaredTerm && declaredTerm !== expectedTerm) continue;
    }
    const parsed = parseGenericLine(row, term, examType, headerBounds);
    if (parsed) schedules.push(parsed);
  }
  return schedules;
}

// Some colleges publish a timetable grid (date rows x period columns) rather than
// one row per course. Rather than guessing cells from column coordinates, dump one
// record per date band (date + its text + room note) so the schedule is never lost.
const GRID_TIME = /^\d{1,2}:\d{2}$/;

function gridTimeRanges(line: TsvWord[]): Array<{ x: number; start: string | null; end: string | null }> {
  const ranges: Array<{ x: number; start: string | null; end: string | null }> = [];
  for (let i = 0; i < line.length; i++) {
    // Period headers sometimes wrap each range in parentheses: "(9:00 ~ 10:00)".
    const start = line[i].text.replace(/[()]/g, '');
    if (!GRID_TIME.test(start)) continue;
    const separator = line[i + 1]?.text ?? '';
    const end = (line[i + 2]?.text ?? '').replace(/[()]/g, '');
    if (end && /^[~～-]$/.test(separator) && GRID_TIME.test(end)) {
      ranges.push({ x: line[i].left, start: toTime(start), end: toTime(end) });
      i += 2;
    }
  }
  return ranges;
}

function parseGridCells(
  words: TsvWord[],
  term: string,
  examType: string,
): Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[] {
  const pages = new Map<number, TsvWord[]>();
  for (const word of words) {
    const page = pages.get(word.page_num) ?? [];
    page.push(word);
    pages.set(word.page_num, page);
  }
  const schedules: Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[] = [];
  for (const page of pages.values()) {
    const lines = groupVisualLines(page);
    // The busiest time-range line is the grid header (12:00 ~ 12:50, one per period).
    const headerLine = lines
      .map((line) => ({ line, ranges: gridTimeRanges(line) }))
      .filter((entry) => entry.ranges.length >= 2)
      .reduce<{ line: TsvWord[]; ranges: ReturnType<typeof gridTimeRanges> } | null>(
        (best, entry) => (!best || entry.ranges.length > best.ranges.length ? entry : best), null);
    if (!headerLine) continue;
    // Dates sit in the left margin; keep every M/D token below the header so a
    // grid whose date column drifts right of the first period still resolves.
    const markers = page.filter((word) => /^\d{1,2}\/\d{1,2}$/.test(word.text)
      && word.top > headerLine.line[0].top).sort((a, b) => a.top - b.top);
    if (markers.length === 0) continue;

    const isContentLine = (line: TsvWord[]): boolean => {
      const text = normalizeCell(line) ?? '';
      if (!text) return false;
      if (gridTimeRanges(line).length >= 6) return false;
      return !/^\s*시간\b/.test(text) && !text.includes('일자') && !text.includes('전공과목구분') && !/시험\s*응시/.test(text);
    };

    for (let i = 0; i < markers.length; i++) {
      const marker = markers[i];
      const previous = markers[i - 1];
      const next = markers[i + 1];
      const lower = previous ? (previous.top + marker.top) / 2 : headerLine.line[0].top;
      const upper = next ? (marker.top + next.top) / 2
        : previous ? marker.top + (marker.top - previous.top) / 2 : marker.top + 200;
      const bandWords: TsvWord[] = [];
      let firstRange: { start: string | null; end: string | null } | undefined;
      for (const line of lines) {
        if (line[0].top <= lower || line[0].top > upper || !isContentLine(line)) continue;
        for (const range of gridTimeRanges(line)) firstRange ??= range;
        for (const word of line) {
          if (/^[~()]$/.test(word.text)) continue;
          if (/^\d{1,2}\/\d{1,2}$/.test(word.text) || /^(시간|일자|교시)$/.test(word.text)) continue;
          bandWords.push(word);
        }
      }
      const rawText = normalizeCell(bandWords);
      if (!rawText || !/[가-힣A-Za-z]/.test(rawText)) continue;
      const room = /시험\s*장소\s*[:：]?\s*([0-9A-Za-z가-힣-]+호?)/.exec(rawText)?.[1] ?? null;
      const name = rawText.replace(/시험\s*장소[\s\S]*$/, '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
      schedules.push({
        term, exam_type: examType, course_code: null, course_name: name || rawText.slice(0, 80),
        section: null, lecture_time: null, instructor: null,
        exam_method: normalizeGenericMethod(rawText.match(GENERIC_METHOD)?.[0]),
        exam_date: toIsoDate(marker.text, term),
        start_time: firstRange?.start ?? null, end_time: firstRange?.end ?? null,
        building: null, rooms: room, note: null, raw_text: rawText,
      });
    }
  }
  return schedules;
}

export function parseExamScheduleTsv(
  tsv: string,
  input: { term: string; exam_type: string },
): ParseExamPdfResult {
  input = { ...input, term: normalizeExamTerm(input.term) };
  const words = parsePdftotextTsv(tsv);
  if (words.length === 0) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNSUPPORTED',
      message: 'PDF에서 텍스트를 추출하지 못했습니다.',
      retryable: false,
      next_action: '스캔 PDF/OCR 문서는 v1에서 지원하지 않습니다. 원본 PDF를 직접 확인하세요.',
    };
  }

  const layout = detectLayout(words);
  if (!layout) {
    const grid = parseGridCells(words, input.term, input.exam_type);
    if (grid.length > 0) {
      return { ok: true, parser: 'pdftotext-tsv', layout: 'grid', schedules: grid };
    }
    const generic = parseGenericRows(words, input.term, input.exam_type);
    if (generic.length > 0) {
      return { ok: true, parser: 'pdftotext-tsv', layout: 'generic', schedules: generic };
    }
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNSUPPORTED',
      message: '지원하지 않는 시험 시간표 PDF 형식입니다.',
      retryable: false,
    };
  }

  const compactSoftware = words.some((word) => word.text === '코드' && word.left >= 50);
  const landscapeSoftware = words.some((word) => word.text === '시험시작시간' && word.left >= 450);
  const combinedGeneralEducation = words.some((word) => word.text === '캠퍼스');
  const separateCampusTimes = combinedGeneralEducation && words.some((word) => word.text === '시작시간');
  const campusVariant = (words.find((word) => /^분반2?$/.test(word.text))?.left ?? 0) > 220
    ? 'campus_midterm' as const : 'campus_final' as const;
  const businessHasCredits = words.some((word) => word.text === '학점');
  const compactBusinessCredits = businessHasCredits && (words.find((word) => word.text === '교과목명')?.left ?? Infinity) < 180;
  const schedules: Omit<ExamScheduleRecord, 'id' | 'source_document_id'>[] = [];
  const codeMin = landscapeSoftware ? 18 : compactSoftware ? 53 : 20;
  const codeMax = landscapeSoftware ? 42 : compactSoftware ? 77 : 52;
  const lines = layout === 'software_college'
    ? groupAnchoredRows(words, (word) => word.left >= codeMin && word.left < codeMax && /^\d{4,6}$/.test(word.text))
    : layout === 'general_education' && combinedGeneralEducation
      ? groupAnchoredRows(words, (word) => word.left < 50 && /^(서울|다빈치|안성)$/.test(word.text))
      : groupVisualLines(words);
  for (const line of lines) {
    const row = layout === 'business_economics'
      ? parseBusinessEconomicsLine(line, input.term, input.exam_type, businessHasCredits, compactBusinessCredits)
      : layout === 'software_college'
      ? parseSoftwareLine(line, input.term, input.exam_type, compactSoftware, landscapeSoftware)
      : separateCampusTimes
        ? parseGeneralEducationLine(line, input.term, input.exam_type, campusVariant)
        : combinedGeneralEducation
        ? parseGeneralEducationCombinedLine(line, input.term, input.exam_type)
        : parseGeneralEducationLine(line, input.term, input.exam_type);
    if (row) {
      schedules.push(row);
    }
  }

  if (schedules.length === 0) {
    const generic = parseGenericRows(words, input.term, input.exam_type);
    if (generic.length > 0) {
      return { ok: true, parser: 'pdftotext-tsv', layout: 'generic', schedules: generic };
    }
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNSUPPORTED',
      message: '시험 시간표 행을 식별하지 못했습니다.',
      retryable: false,
    };
  }

  // A layout match only wins when it actually recovers fields. If the specialized
  // parser finds rows but no instructors while the header-mapped path does, absorb
  // it (e.g. an unfamiliar print variant of a known college).
  {
    const generic = parseGenericRows(words, input.term, input.exam_type);
    const specializedInstructors = schedules.filter((row) => row.instructor).length;
    const genericInstructors = generic.filter((row) => row.instructor).length;
    if (specializedInstructors === 0 && genericInstructors * 2 > generic.length) {
      return { ok: true, parser: 'pdftotext-tsv', layout: 'generic', schedules: generic };
    }
  }

  return { ok: true, parser: 'pdftotext-tsv', layout, schedules };
}

export async function parseExamPdf(
  pdfPath: string,
  input: { term: string; exam_type: string },
): Promise<ParseExamPdfResult> {
  try {
    await execFileAsync('pdftotext', ['-v']);
  } catch (err) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNAVAILABLE',
      message: 'pdftotext 실행 파일을 찾을 수 없습니다.',
      retryable: false,
      next_action: 'poppler를 설치한 뒤 다시 실행하세요. macOS: brew install poppler',
      debug: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const { stdout } = await execFileAsync('pdftotext', ['-tsv', pdfPath, '-'], {
      maxBuffer: 50 * 1024 * 1024,
    });
    return parseExamScheduleTsv(stdout, input);
  } catch (err) {
    return {
      ok: false,
      error_code: 'EXAM_PARSER_FAILED',
      message: 'PDF 텍스트 추출 중 오류가 발생했습니다.',
      retryable: true,
      debug: err instanceof Error ? err.message : String(err),
    };
  }
}
