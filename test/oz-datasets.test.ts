import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapOzDatasetsToSyllabusDocument } from '../src/tools/syllabus/oz-datasets.ts';

// 실제 학교 응답이 아니라 schema만 흉내 낸 합성 데이터. 값은 전부 가상이다.
const datasets = {
  ds_basicinfo: [
    {
      YEAR: '2099', SHTM: 'S', CAMPNM: '서울(Seoul Campus)', SBJTNO: '99999', CLSSNO: '01',
      PNT: '3', SBJTNM: '테스트과목(TEST COURSE)', SBJTENGNM: 'TEST COURSE',
      LTBDRM: '101관 101호', POBTNM: '전공(Major)', LTTYPE: '단독강의(Lone)',
      LTGB: '이론(Theoretical)', LANGGB: null, COLGNM: '테스트대학(College)',
      SUSTNM: '테스트학부(School)', ECLASSFGNM: 'Yes',
      PROFNM: '홍길동(Gildong Hong)', EMAIL: 'test@example.com', OFCETELNO: '02-000-0000',
      CONTACTNO: '02-111-1111', CONSULT: '수업 후', OFFICE: '101관 102호',
      WEBSITE: 'https://example.com', SBJTBRIF: '과목 설명입니다.',
      PRESBJTFG: 'Y', PRESBJT: '선수과목', LTPURP1: '학습 목표', LTOUTCOMES1: '학습 성과',
    },
  ],
  ds_textbooks: [
    { BOOKGBNM: '주교재(Main Textbook)', BOOKNM: 'Book One', BOOKWRITER: 'Author A',
      BOOKETC: '2020', BOOKPRESS: 'Press', BOOKINFO: '1st' },
  ],
  ds_studentAssessment: [
    { LCODENM: '출결(Attendance)', RATE: '10', ADDEXP: null },
    { LCODENM: '중간시험(Mid-term Exam)', RATE: '40', ADDEXP: '오픈북' },
  ],
  ds_courseschedule: [
    { SEQ: '2', PROF: 'Gildong Hong', TITLE: 'Week  Two', PROJ: 'read ch2', STUPRE: 'not displayed', ADDEXP: null },
    { SEQ: '1', PROF: 'Gildong Hong', TITLE: 'Week One', PROJ: null, ADDEXP: 'intro' },
  ],
};

test('maps OZ datasets to the SyllabusDocument contract', () => {
  const doc = mapOzDatasetsToSyllabusDocument(datasets);

  assert.equal(doc.basic.year, '2099');
  assert.equal(doc.basic.term, 'S');
  assert.equal(doc.basic.campus, '서울');
  assert.equal(doc.basic.course_code, '99999');
  assert.equal(doc.basic.section, '01');
  assert.equal(doc.basic.credit, '3');
  assert.equal(doc.basic.title_ko, '테스트과목');
  assert.equal(doc.basic.title_en, 'TEST COURSE');
  assert.equal(doc.basic.classification, '전공');
  assert.equal(doc.basic.lecture_type, '단독강의');
  assert.equal(doc.basic.course_type, '이론');
  assert.equal(doc.basic.medium, null);
  assert.equal(doc.basic.college, '테스트대학');
  assert.equal(doc.basic.department, '테스트학부');
  assert.equal(doc.basic.eclass_usage, 'Yes');

  assert.equal(doc.instructor.name, '홍길동');
  assert.equal(doc.instructor.email, 'test@example.com');
  assert.equal(doc.instructor.homepage, 'https://example.com');

  assert.equal(doc.objectives.description, '과목 설명입니다.');
  assert.equal(doc.objectives.prerequisites, '선수과목');
  assert.equal(doc.objectives.learning_objectives, '학습 목표');
  assert.equal(doc.objectives.learning_outcomes, '학습 성과');

  assert.deepEqual(doc.textbooks, [
    { kind: '주교재', title: 'Book One', author: 'Author A', year: '2020', publisher: 'Press', edition: '1st' },
  ]);

  assert.deepEqual(doc.assessment, [
    { item: '출결', ratio: 10, description: null },
    { item: '중간시험', ratio: 40, description: '오픈북' },
  ]);

  // SEQ 정렬 + 유효 주차만 유지.
  assert.deepEqual(doc.schedule.map((w) => w.week), [1, 2]);
  assert.equal(doc.schedule[0].topic, 'Week One');
  assert.equal(doc.schedule[0].instructor_assignment, 'intro');
  assert.equal(doc.schedule[1].student_assignment, 'read ch2');
  assert.equal(doc.schedule[1].topic, 'Week Two');
  assert.equal(doc.schedule[0].student_assignment, null);
  assert.match(doc.raw_text, /ds_courseschedule/);
  assert.match(doc.raw_text, /not displayed/);
});

test('missing datasets and fields degrade to null/empty without throwing', () => {
  const doc = mapOzDatasetsToSyllabusDocument({ ds_basicinfo: [{ SBJTNM: '', PNT: null }] });
  assert.equal(doc.basic.title_ko, null);
  assert.equal(doc.basic.credit, null);
  assert.equal(doc.instructor.name, null);
  assert.deepEqual(doc.textbooks, []);
  assert.deepEqual(doc.assessment, []);
  assert.deepEqual(doc.schedule, []);
  assert.match(doc.raw_text, /ds_basicinfo/);
});

test('prerequisites binds PRESBJT directly regardless of the unused flag', () => {
  for (const flag of ['Y', 'N', null, undefined, 'other']) {
    assert.equal(mapOzDatasetsToSyllabusDocument({ ds_basicinfo: [{ PRESBJTFG: flag, PRESBJT: 'x' }] }).objectives.prerequisites, 'x');
    assert.equal(mapOzDatasetsToSyllabusDocument({ ds_basicinfo: [{ PRESBJTFG: flag, PRESBJT: '  ' }] }).objectives.prerequisites, null);
  }
});

function validationSample() {
  return {
    ds_basicinfo: [{ YEAR: '2026', SHTM: 'S', SBJTNO: '15841', CLSSNO: '01',
      SBJTNM: '운영체제(OPERATING SYSTEMS)', SBJTENGNM: 'OPERATING SYSTEMS',
      LTTYPE: '단독강의(Lone-teaching course)', LTGB: '이론(Theoretical course)',
      LANGGB: null, PRESBJT: 'C programming', LTPURP1: '목표', LTOUTCOMES1: '성과' }],
    ds_courseschedule: [{ SEQ: '2', TITLE: 'Processes', PROJ: 'Exercise', ADDEXP: null,
      STUPRE: 'not a displayed template column' }, { SEQ: '1', TITLE: 'Introduction' }],
    ds_textbooks: [{ SEQ: '1', BOOKGBNM: '주교재(Main Textbook)', BOOKNM: 'OSTEP',
      BOOKWRITER: 'Example Author', BOOKETC: '2018', BOOKPRESS: 'Example Press', BOOKINFO: 'Version 1.00' }],
    ds_studentAssessment: [{ SEQ: '1', LCODENM: '출결(Attendance)', RATE: '10', ADDEXP: null }],
    ds_assignments: [{ EXP1: 'Unmapped source content' }], OZParam: [{ emp_no: 'not-report-content' }],
  };
}
test('maps OZR bindings, keeps blanks null, orders weeks and retains unmapped content', () => {
  const d = mapOzDatasetsToSyllabusDocument(validationSample());
  assert.equal(d.basic.title_ko, '운영체제');
  assert.equal(d.basic.lecture_type, '단독강의');
  assert.equal(d.basic.course_type, '이론');
  assert.equal(d.basic.medium, null);
  assert.equal(d.objectives.prerequisites, 'C programming');
  assert.deepEqual(d.schedule.map((r) => r.week), [1, 2]);
  assert.equal(d.schedule[1].student_assignment, 'Exercise');
  assert.equal(d.schedule[1].instructor_assignment, null);
  assert.deepEqual(d.textbooks[0], { kind: '주교재', title: 'OSTEP', author: 'Example Author', year: '2018', publisher: 'Example Press', edition: 'Version 1.00' });
  assert.deepEqual(d.assessment[0], { item: '출결', ratio: 10, description: null });
  assert.match(d.raw_text, /Unmapped source content/);
  assert.doesNotMatch(d.raw_text, /not-report-content/);
});
test('rejects ambiguous basic info, invalid percentages and duplicate weeks', () => {
  assert.throws(() => mapOzDatasetsToSyllabusDocument({ ds_basicinfo: [] }), /one OZ/);
  const badRate = validationSample(); badRate.ds_studentAssessment[0].RATE = '101';
  assert.throws(() => mapOzDatasetsToSyllabusDocument(badRate), /assessment/);
  const duplicate = validationSample(); duplicate.ds_courseschedule[0].SEQ = '1';
  assert.throws(() => mapOzDatasetsToSyllabusDocument(duplicate), /Duplicate/);
});
