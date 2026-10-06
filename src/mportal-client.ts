import type { SyllabusSearchItem } from './tools/syllabus/types.js';
import { fetchOzSyllabus, OzSyllabusError } from './oz-client.js';
import type { SyllabusDocument } from './tools/syllabus/types.js';

interface RawSyllabusRow {
  year?: string; shtm?: string; campcd?: string; sbjtno1?: string; clssno1?: string;
  sbjtno?: string; kornm?: string; sust?: string; colgnm?: string; corscd?: string;
  shtnm?: string; profnm?: string; ltbdrm?: string; fileusefg?: string | null;
}

export function normalizeSyllabusSearch(body: unknown): SyllabusSearchItem[] {
  const rows = (body as { result?: RawSyllabusRow[] })?.result;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const [college, department] = (r.colgnm ?? '').split(/<br\s*\/?>/i).map((s) => s.trim());
    return {
      year: r.year ?? '', term: r.shtm ?? '', campus_code: r.campcd ?? '',
      course_code: r.sbjtno1 ?? '', section: r.clssno1 ?? '',
      course_no_full: r.sbjtno ?? '', course_name: r.kornm ?? '', sust_code: r.sust ?? '',
      college: college || null, department: department || null,
      classification: r.shtnm ?? null, professor: r.profnm ?? null, time_room: r.ltbdrm ?? null,
      has_file: r.fileusefg != null,
    };
  });
}

export interface SearchSyllabusInput {
  year?: string; term?: string; query: string; by?: 'subject' | 'professor';
}

export async function searchSyllabusList(
  session: { mportalPostJson<T>(path: string, body: Record<string, unknown>): Promise<T> }, input: SearchSyllabusInput,
): Promise<{ ok: true; items: SyllabusSearchItem[] } | { ok: false; error_code: string; message: string }> {
  try {
    // year/term 미지정 시 현재 학기 조회
    let year = input.year, term = input.term;
    if (!year || !term) {
      const cur = await session.mportalPostJson<{ year?: Array<{ year?: string; shtm?: string }> }>(
        '/std/usk/sUskSif002/selectCurYear.ajax', {});
      year = year ?? cur.year?.[0]?.year;
      term = term ?? cur.year?.[0]?.shtm;
    }
    if (!year || !term) return { ok: false, error_code: 'SYLLABUS_TERM_UNRESOLVED', message: '현재 학기 조회 실패' };
    const choice = input.by === 'professor' ? 'prof' : 'sbjt';
    const body = await session.mportalPostJson<{ msgCode?: string }>(
      '/std/usk/sUskSif002/selectList.ajax',
      { year, shtm: term, choice, searchnm: input.query });
    if (body?.msgCode !== 'success') {
      return { ok: false, error_code: 'SYLLABUS_SEARCH_FAILED', message: '포털 강의계획서 검색에 실패했습니다.' };
    }
    return { ok: true, items: normalizeSyllabusSearch(body) };
  } catch {
    return { ok: false, error_code: 'SYLLABUS_SEARCH_FAILED', message: '포털 강의계획서 검색에 실패했습니다.' };
  }
}

export interface GetSyllabusInput {
  year: string; term: string; sbjtno1: string; clssno1: string;
  campcd: string; sust: string;
}

export async function getSyllabus(
  input: GetSyllabusInput,
): Promise<{ ok: true; document: SyllabusDocument } | { ok: false; error_code: string; message: string }> {
  try {
    return { ok: true, document: await fetchOzSyllabus(input) };
  } catch (err) {
    return { ok: false, error_code: err instanceof OzSyllabusError ? err.code : 'SYLLABUS_INTERNAL_ERROR',
      message: err instanceof OzSyllabusError ? err.message : '강의계획서 데이터 조회에 실패했습니다.' };
  }
}
