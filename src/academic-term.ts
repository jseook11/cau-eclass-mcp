export type ExamSemester = '1' | '2' | 'S' | 'W';

export interface ExamTerm {
  year: number;
  semester: ExamSemester;
  canonical: string;
}

function makeTerm(year: string, semester: string): ExamTerm {
  const normalized = semester.toLowerCase();
  const code: ExamSemester = /^(s|summer|하계|여름)$/.test(normalized) ? 'S'
    : /^(w|winter|동계|겨울)$/.test(normalized) ? 'W'
      : normalized as '1' | '2';
  return { year: Number(year), semester: code, canonical: `${year}-${code}` };
}

export function parseExamTerm(value: string): ExamTerm | null {
  const compact = value.replace(/\s+/g, '');
  const regular = /^(20\d{2})(?:학년도|년|[-_.])제?([12])(?:학기)?$/i.exec(compact);
  const seasonal = /^(20\d{2})(?:학년도|년)?[-_.]?(S|W|summer|winter|하계|여름|동계|겨울)(?:계절학기|계절|학기)?$/i.exec(compact);
  const match = regular ?? seasonal;
  return match ? makeTerm(match[1], match[2]) : null;
}

export function normalizeExamTerm(value: string): string {
  const term = parseExamTerm(value);
  if (!term) throw new Error('INVALID_EXAM_TERM: 학기는 YYYY-1, YYYY-2, YYYY-S(하계), YYYY-W(동계) 또는 연도가 포함된 한글 학기명으로 지정하세요.');
  return term.canonical;
}

export function extractExamTerms(text: string): ExamTerm[] {
  const compact = text.replace(/\s+/g, '');
  // 날짜의 월/일이나 첨부파일의 일련번호를 정규학기로 해석하지 않는다.
  const pattern = /(?<!\d)(20\d{2})(?:(?:학년도|년|[-_.])제?([12])(?:학기)?(?!\d|[-_.]\d)|(?:학년도|년)?[-_.]?(하계|여름|동계|겨울|summer|winter)(?:계절학기|계절|학기)?|[-_.]([SW])(?:학기)?(?![A-Za-z0-9]))/gi;
  return [...compact.matchAll(pattern)].map((match) => makeTerm(match[1], match[2] ?? match[3] ?? match[4]));
}
