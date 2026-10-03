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

type PdfLayout = 'general_education' | 'software_college' | 'business_economics';

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
    return {
      ok: false,
      error_code: 'EXAM_PARSER_UNSUPPORTED',
      message: '시험 시간표 행을 식별하지 못했습니다.',
      retryable: false,
    };
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
