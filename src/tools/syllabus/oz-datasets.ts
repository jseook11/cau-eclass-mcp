import type { SyllabusDocument } from './types.js';

type Row = Record<string, unknown>;
export type OzDatasets = Record<string, Row[]>;

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid OZ syllabus value');
  return String(value).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim() || null;
}
function korean(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  const m = /^([가-힣A-Za-z0-9·\s]+?)\s*\(/.exec(s);
  return (m ? m[1] : s).trim() || null;
}
function ordered(rows: Row[] = []): Row[] {
  return [...rows].sort((a, b) => Number(a.SEQ) - Number(b.SEQ));
}

// CAU pUskLei008.ozr COLNAME/SELLABEL bindings, observed 2026-10-06.
// Blank cells stay null; bilingual labels use Korean.
// The prerequisite band binds PRESBJT directly; the report has no PRESBJTFG condition.
export function mapOzDatasetsToSyllabusDocument(datasets: OzDatasets): SyllabusDocument {
  if (datasets.ds_basicinfo?.length !== 1) throw new Error('Expected one OZ syllabus basic row');
  const b = datasets.ds_basicinfo[0];
  const schedule = ordered(datasets.ds_courseschedule).map((r) => {
    const week = Number(r.SEQ);
    if (!Number.isInteger(week) || week < 1 || week > 30) throw new Error('Invalid OZ syllabus week');
    return { week, instructor: text(r.PROF), topic: text(r.TITLE),
      student_assignment: text(r.PROJ), instructor_assignment: text(r.ADDEXP) };
  });
  if (new Set(schedule.map((r) => r.week)).size !== schedule.length) throw new Error('Duplicate OZ syllabus week');
  return {
    basic: {
      year: text(b.YEAR), term: text(b.SHTM), campus: korean(b.CAMPNM),
      course_code: text(b.SBJTNO), section: text(b.CLSSNO), credit: text(b.PNT),
      title_ko: korean(b.SBJTNM), title_en: text(b.SBJTENGNM), time_room: text(b.LTBDRM),
      classification: korean(b.POBTNM), lecture_type: korean(b.LTTYPE), course_type: korean(b.LTGB),
      medium: korean(b.LANGGB), college: korean(b.COLGNM), department: korean(b.SUSTNM),
      eclass_usage: text(b.ECLASSFGNM),
    },
    instructor: {
      name: korean(b.PROFNM), email: text(b.EMAIL), office_phone: text(b.OFCETELNO),
      contact: text(b.CONTACTNO), office_hour: text(b.CONSULT), office_location: text(b.OFFICE),
      homepage: text(b.WEBSITE),
    },
    objectives: {
      description: text(b.SBJTBRIF), prerequisites: text(b.PRESBJT),
      learning_objectives: text(b.LTPURP1), learning_outcomes: text(b.LTOUTCOMES1),
    },
    textbooks: ordered(datasets.ds_textbooks).map((r) => ({
      kind: korean(r.BOOKGBNM), title: text(r.BOOKNM), author: text(r.BOOKWRITER),
      year: text(r.BOOKETC), publisher: text(r.BOOKPRESS), edition: text(r.BOOKINFO),
    })),
    assessment: ordered(datasets.ds_studentAssessment).map((r) => {
      const item = korean(r.LCODENM);
      const rate = text(r.RATE);
      const ratio = rate === null ? null : Number(rate);
      if (!item || (ratio !== null && (!Number.isFinite(ratio) || ratio < 0 || ratio > 100))) {
        throw new Error('Invalid OZ syllabus assessment');
      }
      return { item, ratio, description: text(r.ADDEXP) };
    }),
    schedule,
    // Contract fallback retains all unmapped datasets (methods, assignments, etc.).
    // The source representation contains group names and original row values.
    raw_text: Object.entries(datasets).filter(([name]) => name !== 'OZParam')
      .map(([name, rows]) => `${name}\n${JSON.stringify(rows, null, 2)}`).join('\n\n'),
  };
}
