import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ExamCache, type CourseMetadataRecord } from '../src/exam-cache.js';
import { parseCseNoticeHtml, parseGeNoticeHtml, parseGenericNoticeHtml, parseBneNoticeHtml, parseExamNoticeLinks, fetchNoticeDocument, matchesExamNotice, selectSourcesForCourse, BUILTIN_EXAM_SOURCES } from '../src/tools/exams/notice-sources.js';
import { parseExamScheduleTsv } from '../src/tools/exams/pdf-parser.js';
import { normalizeSisCourseInfo, parseSisSourceId } from '../src/learningx-client.js';
import { syncCourseMetadata, parseCanvasAccountName } from '../src/tools/exams/course-metadata.js';
import { getExamSchedule } from '../src/tools/exams/get-exam-schedule.js';
import { syncExamSchedules } from '../src/tools/exams/sync-exam-schedules.js';
import { createEclassServer } from '../src/server.js';
import type { CanvasClient } from '../src/canvas-client.js';
import type { BrowserSession } from '../src/browser-session.js';
import type { FileCache } from '../src/file-cache.js';

function word(page: number, left: number, top: number, text: string, width = 8): string {
  return `5\t${page}\t0\t0\t0\t0\t${left}\t${top}\t${width}\t5\t100\t${text}`;
}

function tsv(words: string[]): string {
  return [
    'level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    ...words,
  ].join('\n');
}

function withTempExamDb<T>(fn: (dbPath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-cache-'));
  const dbPath = path.join(dir, 'exams.db');
  const prev = process.env.ECLASS_EXAM_DB_PATH;
  process.env.ECLASS_EXAM_DB_PATH = dbPath;
  const cleanup = (): void => {
    if (prev === undefined) delete process.env.ECLASS_EXAM_DB_PATH;
    else process.env.ECLASS_EXAM_DB_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dbPath);
    if (result instanceof Promise) return result.finally(cleanup) as T;
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}

function examFixture(college: 'ge' | 'cse'): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `exam-midterm-${college}-2026-1.tsv`), 'utf8');
}

function cseMidtermNotice(uid = 9151): string {
  return `<div class="header"><h3>2026-1학기 중간시험 건물번호 수정 안내</h3><span>2026-04-15</span></div>
    <div class="detail"><div class="files">
    <span onclick="goLocation('/_module/bbs/download.php','${uid}','oktomato_bbs05')">(수정)2026-1학기 소프트웨어대학 중간시험 시간표.pdf</span>
    </div></div>`;
}

function bneNotice(title: string, id = 1688): string {
  return `<th colspan="6" class="tit">${title}</th><th>작성일</th><td>2026.07.01</td>
    <ul class="fileList"><a href="/common/board/download.php?flag=NOTICE&amp;idx=${id}&amp;sort=1">${title}.pdf</a></ul>
    <div class="viewCont">시간표 변경은 과목별 공지 확인</div>`;
}

function bneFixture(season: 'summer' | 'winter'): string {
  // Official excerpts: bne.cau.ac.kr notice idx=1688 (summer), idx=1649 (winter).
  const year = season === 'summer' ? 2026 : 2025;
  return fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `exam-bne-${season}-${year}.tsv`), 'utf8');
}

function sampleMetadata(overrides: Partial<CourseMetadataRecord> = {}): CourseMetadataRecord {
  return {
    course_id: 10,
    course_name: '소프트웨어공학',
    term: '2026-1',
    canvas_course_code: '2026-1-11708-01',
    canvas_sis_course_id: '2026-10-11708-01',
    college: '소프트웨어대학',
    department: '소프트웨어학부',
    instructor: '이찬근',
    course_code: '11708',
    section: '01',
    source: 'learningx_sis',
    sis_error: null,
    fetched_at: '2026-06-13T00:00:00.000Z',
    ...overrides,
  };
}

function insertSampleSchedule(cache: ExamCache): number {
  const sourceId = cache.upsertExamSource({
    college: '소프트웨어대학',
    department: '소프트웨어학부',
    homepage_url: 'https://cse.cau.ac.kr/',
    notice_board_url: 'https://cse.cau.ac.kr/sub05/sub0501.php',
    adapter_type: 'cse_notice',
  });
  const documentId = cache.upsertExamDocument({
    term: '2026-1',
    exam_type: 'final',
    source_id: sourceId,
    notice_url: 'https://cse.cau.ac.kr/sub05/sub0501.php',
    title: '시험',
    posted_at: '2026-06-09',
    body_hash: 'body1',
    attachment_url: 'https://cse.cau.ac.kr/a.pdf',
    attachment_name: 'a.pdf',
    file_hash: 'file1',
    local_pdf_path: '/tmp/a.pdf',
    diff_status: 'new',
    fetched_at: '2026-06-13T00:00:00.000Z',
  });
  cache.replaceSchedules(documentId, [{
    term: '2026-1',
    exam_type: 'final',
    course_code: '11708',
    course_name: '소프트웨어공학',
    section: '01',
    lecture_time: '월7 / 수7,8',
    instructor: '이찬근',
    exam_method: '1. 대면시험',
    exam_date: '2026-06-17',
    start_time: '15:00',
    end_time: '16:40',
    building: '310',
    rooms: '727',
    note: null,
    raw_text: null,
  }, {
    term: '2026-1',
    exam_type: 'final',
    course_code: '40989',
    course_name: '자료구조',
    section: '03',
    lecture_time: null,
    instructor: '김범수',
    exam_method: '1. 대면시험',
    exam_date: '2026-06-18',
    start_time: '10:00',
    end_time: '11:40',
    building: '310',
    rooms: '512',
    note: null,
    raw_text: null,
  }, {
    // 교양대학 PDF row: course_code가 없고 이름은 분반 표기 없이 저장된다
    term: '2026-1',
    exam_type: 'final',
    course_code: null,
    course_name: '과학기술과현대사회',
    section: '02',
    lecture_time: '월1,2,3',
    instructor: '김광호',
    exam_method: '1.대면시험',
    exam_date: '2026-06-22',
    start_time: '10:00',
    end_time: '10:50',
    building: '310',
    rooms: 'B602',
    note: null,
    raw_text: null,
  }]);
  return documentId;
}

test('parseGeNoticeHtml extracts attachment metadata', () => {
  const html = `
    <p class="tit"><img /><strong>2026-1학기 서울캠퍼스 교양과목 기말시험 시간표 공지</strong></p>
    <li><strong>작성일</strong><span class="r">2026-06-04</span></li>
    <div class="view_file"><a href="download.php?filename=test.pdf&filepath=NOTICE"><b>교양 기말.pdf</b></a></div>
    <div class="view_con">변경사항(2026.6.12.) : 강의실 변경</div> <!-- // view_con -->
  `;
  const parsed = parseGeNoticeHtml(html, 'https://ge.cau.ac.kr/board_notice_view.php?no=1');
  assert.ok(parsed);
  assert.equal(parsed.title, '2026-1학기 서울캠퍼스 교양과목 기말시험 시간표 공지');
  assert.equal(parsed.posted_at, '2026-06-04');
  assert.equal(parsed.attachment_name, '교양 기말.pdf');
  assert.equal(parsed.attachment_url, 'https://ge.cau.ac.kr/download.php?filename=test.pdf&filepath=NOTICE');
  assert.match(parsed.body_text, /강의실 변경/);
});

test('parseCseNoticeHtml extracts goLocation download link', () => {
  const html = `
    <div class="header"><h3>2026-1학기 기말시험 시간표 안내</h3><div><span>2026-06-09</span></div></div>
    <div class="detail"><div class="files">
      <span onclick="goLocation('/_module/bbs/download.php','9280','oktomato_bbs05')">2026-1학기 소프트웨어대학 기말시험 시간표(공지용).pdf</span>
    </div></div>
  `;
  const parsed = parseCseNoticeHtml(html, 'https://cse.cau.ac.kr/sub05/sub0501.php?nmode=view&code=oktomato_bbs05&uid=3396');
  assert.ok(parsed);
  assert.equal(parsed.title, '2026-1학기 기말시험 시간표 안내');
  assert.equal(parsed.posted_at, '2026-06-09');
  assert.equal(parsed.attachment_url, 'https://cse.cau.ac.kr/_module/bbs/download.php?uid=9280&code=oktomato_bbs05');
});

test('notice adapters select the matching PDF and reject another term or exam type', () => {
  const filter = { term: '2026-1', exam_type: 'midterm' as const };
  const html = `<p class="tit"><strong>2026학년도 1학기 서울캠퍼스 중간시험 시간표</strong></p>
    <div class="view_file"><div class="left">첨부파일</div><ul>
      <li><a href="rules.pdf"><b>시험 지침.pdf</b></a></li>
      <li><a href="schedule.xlsx"><b>중간시험 시간표.xlsx</b></a></li>
      <li><a href="midterm.pdf"><b>2026-1학기 중간시험 시간표.pdf</b></a></li>
    </ul></div><div class="view_con">시험 안내</div> <!-- // view_con -->`;
  const noticeUrl = 'https://ge.cau.ac.kr/board_notice_view.php?no=1571';
  assert.equal(parseGeNoticeHtml(html, noticeUrl, filter)?.attachment_url, 'https://ge.cau.ac.kr/midterm.pdf');
  assert.equal(parseGeNoticeHtml(html, noticeUrl, { ...filter, exam_type: 'final' }), null);
  assert.equal(parseGeNoticeHtml(html, noticeUrl, { ...filter, term: '2026-2' }), null);

  const cse = cseMidtermNotice().replace('<div class="files">', `<div class="files">
    <span onclick="goLocation('/_module/bbs/download.php','1','oktomato_bbs05')">지침.hwp</span>`);
  assert.match(parseCseNoticeHtml(cse, 'https://cse.cau.ac.kr/sub05/sub0501.php?uid=3352', filter)?.attachment_url ?? '', /uid=9151/);
  assert.equal(parseCseNoticeHtml(cse, noticeUrl, { ...filter, exam_type: 'final' }), null);

  const generic = '<h2>2026-1학기 중간시험 시간표</h2><a href="midterm.pdf">midterm.pdf</a>';
  assert.ok(parseGenericNoticeHtml(generic, 'https://college.cau.ac.kr/notice', filter));
});

test('parseExamNoticeLinks filters term/type/campus and prioritizes revised notices', () => {
  const filter = { term: '2026-1', exam_type: 'midterm' as const };
  const board = 'https://cse.cau.ac.kr/sub05/sub0501.php';
  const html = `<a href="?nmode=view&uid=3349">2026-1학기 중간시험 시간표 안내</a>
    <a href="?nmode=view&amp;uid=3352"><!-- comment -->2026-1학기 중간시험 건물번호 수정 안내</a>
    <a href="?nmode=view&uid=3396">2026-1학기 기말시험 시간표 안내</a>
    <a href="?nmode=view&uid=3459">2026학년도 2학기 중간시험 시간표 안내</a>
    <a href="?nmode=view&uid=3346">2026학년도 1학기 중간시험 공정관리 지침</a>
    <a href="https://evil.example/?uid=9999">2026-1학기 중간시험 시간표</a>`;
  assert.deepEqual(parseExamNoticeLinks(html, board, filter).map((url) => new URL(url).searchParams.get('uid')), ['3352', '3349']);
  const geHtml = `<a href="board_notice_view.php?no=1572">2026-1학기 다빈치캠퍼스 중간시험 시간표</a>
    <a href="board_notice_view.php?no=1571">2026-1학기 서울캠퍼스 중간시험 시간표</a>`;
  assert.equal(parseExamNoticeLinks(geHtml, 'https://ge.cau.ac.kr/board_notice.php', filter).length, 1);
});

test('fetchNoticeDocument searches later pages and never relabels a final notice as midterm', async () => {
  const originalFetch = globalThis.fetch;
  const visited: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    visited.push(url.toString());
    if (url.searchParams.has('uid')) return new Response(cseMidtermNotice());
    assert.equal(url.searchParams.get('keyword'), '중간');
    if (url.searchParams.get('offset') === '1') {
      return new Response('<a href="?offset=2&nmode=list">2</a>');
    }
    return new Response('<a href="?nmode=view&uid=3352">2026-1학기 중간시험 수정 안내</a>');
  };
  try {
    const source = BUILTIN_EXAM_SOURCES.find((source) => source.adapter_type === 'cse_notice')!;
    const result = await fetchNoticeDocument(source, { term: '2026-1', exam_type: 'midterm' });
    assert.match(result?.notice_url ?? '', /uid=3352/);
    assert.equal(visited.length, 3);
    globalThis.fetch = async () => new Response(cseMidtermNotice().replaceAll('중간', '기말'));
    const wrongType = await fetchNoticeDocument({ ...source, notice_board_url: `${source.notice_board_url}?uid=3396` }, {
      term: '2026-1', exam_type: 'midterm',
    });
    assert.equal(wrongType, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parseExamScheduleTsv reads actual general-education midterm columns and special dates', () => {
  const result = parseExamScheduleTsv(examFixture('ge'), { term: '2026-1', exam_type: 'midterm' });
  assert.ok(result.ok);
  assert.equal(result.schedules.length, 48);
  assert.ok(result.schedules.every((row) => row.exam_type === 'midterm'));
  const science = result.schedules.find((row) => row.course_name === '과학기술과현대사회' && row.section === '02')!;
  assert.equal(science.instructor, '김광호');
  assert.equal(science.exam_date, '2026-04-27');
  assert.equal(science.start_time, '10:00');
  assert.equal(science.end_time, '10:50');
  assert.equal(science.building, '310');
  assert.equal(science.rooms, 'B602');
  const replacement = result.schedules.find((row) => row.section === '01')!;
  assert.equal(replacement.exam_method, '과제물대체');
  assert.equal(replacement.exam_date, null);
  const range = result.schedules.find((row) => row.course_name === '공공기관NCS분석')!;
  assert.equal(range.exam_date, null);
  assert.match(range.note ?? '', /3\/31.*4\/13/);
});

test('parseExamScheduleTsv reads actual compact software midterm PDF including corrected rooms', () => {
  const result = parseExamScheduleTsv(examFixture('cse'), { term: '2026-1', exam_type: 'midterm' });
  assert.ok(result.ok);
  assert.equal(result.schedules.length, 5);
  const corrected = result.schedules.find((row) => row.course_code === '32734' && row.section === '02')!;
  assert.equal(corrected.course_name, '컴퓨터시스템및어셈블리언어');
  assert.equal(corrected.exam_date, '2026-04-23');
  assert.equal(corrected.building, '310');
  assert.equal(corrected.rooms, '727 729');
  assert.equal(result.schedules[0].start_time, '09:00');
  assert.equal(result.schedules.find((row) => row.course_code === '17437')?.exam_method, '4.미실시');
});

test('seasonal notices distinguish regular, summer, winter and academic years', () => {
  const url = 'https://bne.cau.ac.kr/bneNews/notice/view.php?idx=1688';
  const summer = parseBneNoticeHtml(bneNotice('2026-하계 계절학기 중간시험 유형 및 시간표'), url, { term: '2026-S', exam_type: 'midterm' });
  assert.ok(summer);
  assert.equal(summer.posted_at, '2026-07-01');
  assert.equal(summer.attachment_url, 'https://bne.cau.ac.kr/common/board/download.php?flag=NOTICE&idx=1688&sort=1');
  for (const term of ['2026-1', '2026-2', '2026-W', '2025-S']) {
    assert.equal(matchesExamNotice(summer, { term, exam_type: 'midterm' }), false, term);
  }
  assert.ok(matchesExamNotice(summer, { term: '2026년 여름 계절학기', exam_type: 'midterm' }));
  const winter = parseBneNoticeHtml(bneNotice('2025-동계 계절학기 기말시험 유형 및 시간표'), url, { term: '2025-W', exam_type: 'final' });
  assert.ok(winter);
  assert.equal(matchesExamNotice(winter, { term: '2026-W', exam_type: 'final' }), false);

  const combined = `<th class="tit">2025-동계 계절학기 중간/기말시험 시간표</th>
    <ul class="fileList"><a href="midterm.pdf">2025-W 중간시험 시간표.pdf</a>
    <a href="final.pdf">2025-W 기말시험 시간표.pdf</a></ul>`;
  assert.match(parseBneNoticeHtml(combined, url, { term: '2025-W', exam_type: 'final' })?.attachment_url ?? '', /final\.pdf$/);
});

test('fetchNoticeDocument discovers both seasonal exam types on the BNE board', async () => {
  const originalFetch = globalThis.fetch;
  const source = BUILTIN_EXAM_SOURCES.find((source) => source.adapter_type === 'bne_notice')!;
  try {
    for (const [term, season] of [['2026-S', '2026-하계'], ['2025-W', '2025-동계']]) {
      for (const examType of ['midterm', 'final'] as const) {
        const title = `${season} 계절학기 ${examType === 'midterm' ? '중간' : '기말'}시험 시간표`;
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          if (url.pathname.endsWith('/view.php')) return new Response(bneNotice(title));
          assert.equal(url.searchParams.get('s_word'), '계절');
          assert.equal(url.searchParams.get('s_key'), 'TITLE');
          return new Response(`<a href="/bneNews/notice/view.php?idx=1688">${title}</a>`);
        };
        assert.equal((await fetchNoticeDocument(source, { term, exam_type: examType }))?.title, title);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('seasonal PDF parsing uses row term codes and preserves full winter dates', () => {
  const summer = parseExamScheduleTsv(bneFixture('summer'), { term: '2026년 하계 계절학기', exam_type: 'midterm' });
  assert.ok(summer.ok);
  assert.equal(summer.layout, 'business_economics');
  assert.equal(summer.schedules.length, 4);
  assert.ok(summer.schedules.every((row) => row.term === '2026-S'));
  assert.equal(summer.schedules[0].course_code, '35703');
  assert.equal(summer.schedules[0].exam_date, '2026-07-03');
  assert.equal(summer.schedules[0].rooms, '311');
  const mismatch = parseExamScheduleTsv(bneFixture('summer'), { term: '2026-1', exam_type: 'midterm' });
  assert.ok(!mismatch.ok);

  const winter = parseExamScheduleTsv(bneFixture('winter'), { term: '2025-W', exam_type: 'final' });
  assert.ok(winter.ok);
  assert.equal(winter.schedules.length, 4);
  assert.equal(winter.schedules[0].exam_date, '2026-01-14');
  const suspicious = winter.schedules.find((row) => row.course_code === '34540')!;
  assert.equal(suspicious.exam_date, '2025-01-14');
  assert.ok(suspicious.note?.trim(), 'an inconsistent source date needs a note');
});

test('second-semester PDFs preserve changed columns, wrapped names and multiple exam dates', () => {
  const readFixture = (type: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `exam-ge-${type}-2025-2.tsv`), 'utf8');
  const midterm = parseExamScheduleTsv(readFixture('midterm'), { term: '2025년 2학기', exam_type: 'midterm' });
  assert.ok(midterm.ok);
  assert.equal(midterm.schedules.length, 3);
  const reading = midterm.schedules.find((row) => row.course_name === 'ACADEMIC READING')!;
  assert.equal(reading.instructor, '이안애시브리지');
  assert.match(reading.note ?? '', /대면수업/);
  const final = parseExamScheduleTsv(readFixture('final'), { term: '2025-2', exam_type: 'final' });
  assert.ok(final.ok);
  assert.equal(final.schedules.length, 5);
  const wrapped = final.schedules.find((row) => row.course_name === 'BRAND COMPETITION AND WINNING STRATEGIES')!;
  assert.equal(wrapped.section, '01');
  assert.equal(wrapped.exam_date, '2025-12-18');
  const communication = final.schedules.find((row) => row.course_name === 'COMMUNICATION IN ENGLISH')!;
  assert.equal(communication.section, '01');
  assert.match(communication.lecture_time ?? '', /월.*수/);
  assert.match(communication.note ?? '', /2025-12-15.*2025-12-17/);
  assert.equal(final.schedules[2].building, '303');
  assert.equal(final.schedules[2].rooms, '802-1');
});

test('summer final PDF supports its compact print layout independently of midterm layout', () => {
  const fixture = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'exam-bne-summer-final-2026.tsv'), 'utf8');
  const result = parseExamScheduleTsv(fixture, { term: '2026-S', exam_type: 'final' });
  assert.ok(result.ok);
  assert.equal(result.schedules.length, 2);
  assert.equal(result.schedules[0].course_code, '35703');
  assert.equal(result.schedules[0].section, '01');
  assert.equal(result.schedules[0].exam_date, '2026-07-15');
  assert.equal(result.schedules[0].end_time, '14:45');
  assert.equal(result.schedules[0].rooms, '311');
});

test('second-semester software PDFs group font offsets within landscape table rows', () => {
  for (const type of ['midterm', 'final'] as const) {
    const fixture = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', `exam-cse-${type}-2025-2.tsv`), 'utf8');
    const result = parseExamScheduleTsv(fixture, { term: '2025-2', exam_type: type });
    assert.ok(result.ok);
    assert.equal(result.schedules.length, 3);
    const programming = result.schedules.find((row) => row.course_code === '47710')!;
    assert.equal(programming.section, '01');
    assert.equal(programming.course_name, '프로그래밍');
    assert.equal(programming.instructor, '이창하');
    assert.equal(programming.start_time, '09:00');
    assert.equal(programming.rooms, 'B311');
    assert.equal(programming.exam_date, type === 'midterm' ? '2025-10-20' : '2025-12-15');
  }
});

test('short winter dates roll over only January and February', () => {
  const makeTsv = (date: string) => tsv([
    word(1, 20, 40, '교양대학'), word(1, 24, 66, '캠퍼스'),
    word(1, 28, 110, '서울'),
    word(1, 58, 110, '시험과목'), word(1, 295, 110, '01'), word(1, 344, 110, '교수'),
    word(1, 497, 110, '대면시험'), word(1, 592, 110, date),
    word(1, 672, 110, '10:00~10:50'), word(1, 759, 110, '310-727'),
  ]);
  for (const [date, expected] of [['1/14(수)', '2026-01-14'], ['2/1(일)', '2026-02-01'], ['12/30(화)', '2025-12-30']]) {
    const result = parseExamScheduleTsv(makeTsv(date), { term: '2025-W', exam_type: 'final' });
    assert.ok(result.ok);
    assert.equal(result.schedules[0].exam_date, expected);
  }
});

test('parseExamScheduleTsv parses software-college rows', () => {
  const input = tsv([
    word(1, 188, 50, '2026-1학기', 40),
    word(1, 245, 50, '소프트웨어학부', 50),
    word(1, 31, 72, '교과목', 12),
    word(1, 33, 76, '코드', 8),
    word(1, 55, 72, '분반', 8),
    word(1, 99, 72, '교과목명', 20),
    word(1, 32, 90, '11708', 10),
    word(1, 58, 90, '01', 4),
    word(1, 94, 90, '소프트웨어공학', 30),
    word(1, 148, 90, '월7', 6),
    word(1, 156, 90, '/', 2),
    word(1, 160, 90, '수7,8', 10),
    word(1, 192, 90, '이찬근', 12),
    word(1, 225, 90, '40', 4),
    word(1, 247, 90, '1.', 4),
    word(1, 253, 90, '대면시험', 18),
    word(1, 288, 90, '2026-06-17', 24),
    word(1, 331, 90, '15:00', 12),
    word(1, 366, 90, '16:40', 12),
    word(1, 401, 90, '310', 8),
    word(1, 434, 90, '727', 8),
  ]);

  const result = parseExamScheduleTsv(input, { term: '2026-1', exam_type: 'final' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.layout, 'software_college');
    assert.equal(result.schedules.length, 1);
    assert.equal(result.schedules[0].course_code, '11708');
    assert.equal(result.schedules[0].course_name, '소프트웨어공학');
    assert.equal(result.schedules[0].exam_date, '2026-06-17');
    assert.equal(result.schedules[0].rooms, '727');
  }
});

test('parseExamScheduleTsv falls back to layout-agnostic rows for unknown formats', () => {
  const input = tsv([
    word(1, 20, 40, '2026학년도 1학기 시험 안내', 120),
    word(1, 20, 80, '54288', 20), word(1, 60, 80, '01'), word(1, 120, 80, '벤처창업경영론', 60),
    word(1, 300, 80, '월7,8,9'), word(1, 400, 80, '최용석'), word(1, 470, 80, '1.'),
    word(1, 482, 80, '대면시험'), word(1, 560, 80, '2026-06-19'), word(1, 650, 80, '12:00'),
    word(1, 700, 80, '13:00'), word(1, 760, 80, '310'), word(1, 800, 80, '932'),
    word(1, 20, 110, '54293', 20), word(1, 60, 110, '01'), word(1, 120, 110, '창업투자와 M&A', 70),
    word(1, 300, 110, '화4,5,6'), word(1, 400, 110, '최용석'), word(1, 470, 110, '3.'),
    word(1, 482, 110, '과제물대체'),
  ]);
  const result = parseExamScheduleTsv(input, { term: '2026-1', exam_type: 'final' });
  assert.ok(result.ok);
  assert.equal(result.layout, 'generic');
  assert.equal(result.schedules.length, 2);
  const exam = result.schedules[0];
  assert.equal(exam.course_code, '54288');
  assert.equal(exam.course_name, '벤처창업경영론');
  assert.equal(exam.section, '01');
  assert.equal(exam.exam_method, '대면시험');
  assert.equal(exam.exam_date, '2026-06-19');
  assert.equal(exam.start_time, '12:00');
  assert.equal(exam.end_time, '13:00');
  assert.match(exam.raw_text ?? '', /벤처창업경영론/);
  assert.equal(result.schedules[1].exam_method, '과제물대체');
  assert.equal(result.schedules[1].exam_date, null);
});

test('parseExamScheduleTsv parses general-education rows including online exams', () => {
  const input = tsv([
    word(1, 20, 17, '[서울캠퍼스]', 80),
    word(1, 104, 39, '교양대학', 40),
    word(1, 19, 66, '교과목명', 30),
    word(1, 162, 66, '분반', 14),
    word(1, 382, 66, '기말시험', 30),
    word(1, 419, 66, '유형', 14),
    word(1, 19, 110, '4차산업혁명과인재개발', 90),
    word(1, 166, 110, '01', 9),
    word(1, 220, 110, '월11', 18),
    word(1, 301, 110, '송해덕', 25),
    word(1, 367, 110, '2.', 7),
    word(1, 378, 110, '온라인(비대면)시험', 74),
    word(1, 491, 110, '2026-06-22', 44),
    word(1, 591, 110, '19:00', 21),
    word(1, 660, 110, '19:50', 21),
  ]);

  const result = parseExamScheduleTsv(input, { term: '2026-1', exam_type: 'final' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.layout, 'general_education');
    assert.equal(result.schedules[0].course_name, '4차산업혁명과인재개발');
    assert.equal(result.schedules[0].section, '01');
    assert.equal(result.schedules[0].exam_method, '2. 온라인(비대면)시험');
    assert.equal(result.schedules[0].building, null);
  }
});

test('normalizeSisCourseInfo maps known field aliases', () => {
  const fixture = {
    data: {
      colg_nm: '소프트웨어대학',
      sust_nm: '소프트웨어학부',
      prof_nm: '이찬근',
      subj_no: '11708',
      class_no: '01',
      shtm_nm: '2026-1',
      sis_course_id: '2026-10-11708-01',
    },
  };
  const result = normalizeSisCourseInfo(fixture);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.info.college, '소프트웨어대학');
    assert.equal(result.info.department, '소프트웨어학부');
    assert.equal(result.info.instructor, '이찬근');
    assert.equal(result.info.course_code, '11708');
    assert.equal(result.info.section, '01');
    assert.equal(result.info.term, '2026-1');
    assert.equal(result.info.raw_sis_course_id, '2026-10-11708-01');
  }
});

test('normalizeSisCourseInfo parses live LearningX course response via sis_source_id', () => {
  // /learningx/api/v1/courses/{id} live 응답 형태 (2026-06-13 검증).
  // course_code가 표시명이므로 sis_source_id 구조 파싱이 우선해야 한다.
  const fixture = {
    id: 139260,
    name: '컴퓨터시스템및어셈블리언어 01분반',
    course_code: '컴퓨터시스템및어셈블리언어 01분반',
    sis_source_id: '2026_1_1_3B510_32734_01',
    enrollment_term_id: 93,
  };
  const result = normalizeSisCourseInfo(fixture);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.info.course_code, '32734');
    assert.equal(result.info.section, '01');
    assert.equal(result.info.term, '2026-1');
    assert.equal(result.info.raw_sis_course_id, '2026_1_1_3B510_32734_01');
    assert.equal(result.info.college, null);
    assert.equal(result.info.department, null);
  }
});

test('parseSisSourceId rejects non-structured ids', () => {
  assert.equal(parseSisSourceId('2026-10-11708-01'), null);
  assert.equal(parseSisSourceId('not_an_id'), null);
  assert.deepEqual(parseSisSourceId('2026_1_1_3B510_32734_01'), {
    term: '2026-1',
    campus_code: '1',
    department_code: '3B510',
    course_code: '32734',
    section: '01',
  });
});

test('normalizeSisCourseInfo rejects responses without course_code/section', () => {
  const result = normalizeSisCourseInfo({ status: 'ok', message: 'no course info here' });
  assert.equal(result.ok, false);
});

test('exam cache accepts current metadata after opening a legacy database', () => {
  withTempExamDb((dbPath) => {
    const v1 = new Database(dbPath);
    v1.exec(`
      CREATE TABLE course_metadata (
        course_id   INTEGER PRIMARY KEY,
        course_name TEXT NOT NULL,
        course_code TEXT,
        section     TEXT,
        instructor  TEXT,
        college     TEXT,
        department  TEXT,
        term        TEXT,
        source      TEXT NOT NULL,
        confidence  REAL NOT NULL,
        fetched_at  TEXT NOT NULL
      );
    `);
    v1.prepare(`
      INSERT INTO course_metadata (course_id, course_name, source, confidence, fetched_at)
      VALUES (1, '운영체제', 'canvas_course_metadata', 0.75, '2026-06-01T00:00:00.000Z')
    `).run();
    v1.close();

    const cache = new ExamCache();
    const db = cache.getDb();
    cache.upsertCourseMetadata([sampleMetadata()]);
    const stored = cache.getCourseMetadata(10);
    assert.ok(stored);
    assert.equal(stored.source, 'learningx_sis');
    assert.equal(stored.course_code, sampleMetadata().course_code);
    assert.equal(stored.section, sampleMetadata().section);

    // source CHECK 제약: 허용값 외에는 저장 불가
    assert.throws(() => {
      cache.upsertCourseMetadata([{ ...sampleMetadata(), course_id: 11, source: 'bogus' as never }]);
    });
    db.close();
  });
});

test('findSchedulesExact matches course_code + section only', () => {
  withTempExamDb(() => {
    const cache = new ExamCache();
    insertSampleSchedule(cache);

    const exact = cache.findSchedulesExact({
      course_code: '11708',
      section: '01',
      term: '2026-1',
      exam_type: 'final',
    });
    assert.equal(exact.length, 1);
    assert.equal(exact[0].course_name, '소프트웨어공학');
    assert.equal(exact[0].source_title, '시험');

    assert.equal(cache.findSchedulesExact({ course_code: '11708', section: '02' }).length, 0);
    assert.equal(cache.listSchedules({ term: '2026-1', exam_type: 'final' }).length, 3);
    cache.getDb().close();
  });
});

test('findSchedulesByNameSection matches normalized name + section', () => {
  withTempExamDb(() => {
    const cache = new ExamCache();
    insertSampleSchedule(cache);

    // metadata 이름은 "...02분반", PDF row 이름은 분반 표기 없음 → 정규화 후 일치
    const matched = cache.findSchedulesByNameSection({
      course_name: '과학기술과현대사회 02분반',
      section: '02',
      term: '2026-1',
      exam_type: 'final',
    });
    assert.equal(matched.length, 1);
    assert.equal(matched[0].course_name, '과학기술과현대사회');
    assert.equal(matched[0].rooms, 'B602');

    // section이 다르면 매칭 안 됨
    assert.equal(cache.findSchedulesByNameSection({
      course_name: '과학기술과현대사회',
      section: '01',
      term: '2026-1',
      exam_type: 'final',
    }).length, 0);

    // leading zero 차이는 무시 (section "2" == "02")
    assert.equal(cache.findSchedulesByNameSection({
      course_name: '과학기술과현대사회',
      section: '2',
      term: '2026-1',
      exam_type: 'final',
    }).length, 1);
    cache.getDb().close();
  });
});

test('getExamSchedule matches general-education course by name + section', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    // 교양과목: SIS로 course_code/section은 확정되지만 교양 PDF엔 course_code가 없다
    cache.upsertCourseMetadata([sampleMetadata({
      course_id: 30,
      course_name: '과학기술과현대사회 02분반',
      college: '교양대학',
      department: null,
      instructor: '김광호',
      course_code: '40647',
      section: '02',
      source: 'learningx_sis',
    })]);
    insertSampleSchedule(cache);

    const result = await getExamSchedule(cache, { course_id: 30, term: '2026-1' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].course_name, '과학기술과현대사회');
      assert.equal(result.matches[0].rooms, 'B602');
      assert.equal(result.matched_by, 'name_section');
    }
    cache.getDb().close();
  });
});

test('getExamSchedule returns exact match for confirmed course metadata', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    cache.upsertCourseMetadata([sampleMetadata()]);
    insertSampleSchedule(cache);

    const result = await getExamSchedule(cache, { course_id: 10, term: '2026-1' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0].course_code, '11708');
      assert.equal(result.matches[0].section, '01');
    }
    cache.getDb().close();
  });
});

test('getExamSchedule returns full candidate list when exact match fails', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    // canvas_only: course_code/section 미확정 → exact match 불가
    cache.upsertCourseMetadata([sampleMetadata({
      course_id: 20,
      course_name: '일반물리(1) 03분반',
      college: null,
      department: null,
      instructor: null,
      course_code: null,
      section: null,
      source: 'canvas_only',
      sis_error: 'SIS_ENDPOINT_UNAVAILABLE: probe failed',
    })]);
    insertSampleSchedule(cache);

    const result = await getExamSchedule(cache, { course_id: 20, term: '2026-1' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'EXACT_MATCH_NOT_FOUND');
      assert.equal(result.candidates.length, 3);
      assert.equal(result.course_metadata?.source, 'canvas_only');
      assert.equal(result.course_metadata?.sis_error, 'SIS_ENDPOINT_UNAVAILABLE: probe failed');
    }
    cache.getDb().close();
  });
});

test('syncExamSchedules discovers midterm PDFs, retries empty caches and replaces superseded rows', async () => {
  await withTempExamDb(async (dbPath) => {
    const cache = new ExamCache();
    insertSampleSchedule(cache);
    cache.upsertCourseMetadata([sampleMetadata({ course_code: '32734', section: '02' })]);
    cache.upsertExamSource({ ...BUILTIN_EXAM_SOURCES[1], notice_board_url: 'https://cse.cau.ac.kr/sub05/sub0501.php?uid=3396' });
    const originalFetch = globalThis.fetch;
    const previousDownloadDir = process.env.ECLASS_EXAM_DOWNLOAD_DIR;
    process.env.ECLASS_EXAM_DOWNLOAD_DIR = path.join(path.dirname(dbPath), 'downloads');
    let attachmentId = 9151;
    let parseCalls = 0;
    let failParsing = true;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'www.cau.ac.kr') return new Response('');
      if (url.pathname === '/_module/bbs/download.php') return new Response('%PDF test fixture');
      if (url.searchParams.has('uid')) {
        assert.notEqual(url.searchParams.get('uid'), '3396', 'legacy fixed final notice must not be fetched');
        return new Response(cseMidtermNotice(attachmentId));
      }
      assert.equal(url.searchParams.get('keyword'), '중간');
      return new Response('<a href="?nmode=view&uid=3352">2026-1학기 중간시험 건물번호 수정 안내</a>');
    };
    const parsePdf = async (_pdfPath: string, input: { term: string; exam_type: string }) => {
      parseCalls++;
      if (failParsing) return { ok: false as const, error_code: 'EXAM_PARSER_UNAVAILABLE' as const, message: 'not installed', retryable: false };
      return parseExamScheduleTsv(examFixture('cse'), input);
    };
    try {
      const input = { term: '2026-1', exam_type: 'midterm' as const, course_id: 10 };
      const failed = await syncExamSchedules(cache, input, parsePdf);
      assert.equal(failed.sources_checked, 1);
      assert.match(failed.partial_failures[0].reason, /EXAM_PARSER_UNAVAILABLE/);
      assert.equal(cache.listSchedules({ exam_type: 'midterm' }).length, 0);

      failParsing = false;
      const synced = await syncExamSchedules(cache, input, parsePdf);
      assert.equal(synced.documents[0].diff_status, 'unchanged');
      assert.equal(synced.documents[0].parsed_rows, 5);
      const exact = await getExamSchedule(cache, input);
      assert.ok(exact.ok);
      assert.equal(exact.matched_by, 'exact');
      assert.equal(exact.matches[0].building, '310');

      const unchanged = await syncExamSchedules(cache, input, parsePdf);
      assert.equal(unchanged.documents[0].parsed_rows, 0);
      assert.equal(parseCalls, 2);
      attachmentId = 9251;
      const revised = await syncExamSchedules(cache, input, parsePdf);
      assert.equal(revised.documents[0].diff_status, 'new');
      assert.equal(cache.listSchedules({ exam_type: 'midterm' }).length, 5);
      assert.ok(cache.listSchedules({ exam_type: 'midterm' }).every((row) => row.source_document_id === revised.documents[0].document_id));
      assert.equal(cache.listSchedules({ exam_type: 'final' }).length, 3);
      await syncExamSchedules(cache, { ...input, force: true }, parsePdf);
      assert.equal(parseCalls, 4);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousDownloadDir === undefined) delete process.env.ECLASS_EXAM_DOWNLOAD_DIR;
      else process.env.ECLASS_EXAM_DOWNLOAD_DIR = previousDownloadDir;
      cache.getDb().close();
    }
  });
});

test('MCP exposes midterm and returns the complete timetable while final remains the default', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    insertSampleSchedule(cache);
    const previous = cache.findExamDocument('2026-1', 'final', 'https://cse.cau.ac.kr/a.pdf')!;
    const documentId = cache.upsertExamDocument({ ...previous, exam_type: 'midterm', attachment_url: 'https://cse.cau.ac.kr/midterm.pdf' });
    const fixture = parseExamScheduleTsv(examFixture('ge'), { term: '2026-1', exam_type: 'midterm' });
    assert.ok(fixture.ok);
    cache.replaceSchedules(documentId, Array.from({ length: 250 }, (_, i) => ({
      ...fixture.schedules[0], course_name: `교양과목${String(i).padStart(3, '0')}`,
    })));
    const server = createEclassServer({
      username: 'test', session: {} as BrowserSession, fileCache: {} as FileCache, examCache: cache,
    });
    const client = new Client({ name: 'exam-test', version: '0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ['eclass_sync_exam_schedules', 'eclass_get_exam_schedule']) {
        const tool = tools.find((tool) => tool.name === name)!;
        const properties = tool.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>;
        assert.deepEqual(properties.exam_type.enum, ['midterm', 'final']);
        assert.equal(properties.exam_type.default, 'final');
      }
      const midterm = await client.callTool({ name: 'eclass_get_exam_schedule', arguments: { term: '2026-1', exam_type: 'midterm' } });
      assert.equal(midterm.isError, false);
      const result = midterm.structuredContent as { matches: Array<{ exam_type: string }> };
      assert.equal(result.matches.length, 250);
      assert.ok(result.matches.every((row) => row.exam_type === 'midterm'));
      const final = await client.callTool({ name: 'eclass_get_exam_schedule', arguments: { term: '2026-1' } });
      assert.equal((final.structuredContent as { matches: unknown[] }).matches.length, 3);
      const candidates = await getExamSchedule(cache, { term: '2026-1', exam_type: 'midterm', course_id: 999 });
      assert.ok(!candidates.ok);
      assert.equal(candidates.candidates.length, 250);
      const query = await getExamSchedule(cache, { term: '2026-1', exam_type: 'midterm', query: '교양과목249' });
      assert.ok(query.ok);
      assert.equal(query.matches.length, 1);
      assert.equal(cache.listSchedules({ exam_type: 'midterm', limit: 10 }).length, 10);
    } finally {
      await client.close();
      await server.close();
      cache.getDb().close();
    }
  });
});

test('sync and MCP queries isolate all four semesters and both exam types with alias inputs', async () => {
  await withTempExamDb(async (dbPath) => {
    const cache = new ExamCache();
    const originalFetch = globalThis.fetch;
    const previousDir = process.env.ECLASS_EXAM_DOWNLOAD_DIR;
    process.env.ECLASS_EXAM_DOWNLOAD_DIR = path.join(path.dirname(dbPath), 'downloads');
    const terms = [
      { key: '2026-1', label: '2026학년도 1학기' },
      { key: '2026-2', label: '2026년 2학기' },
      { key: '2026-S', label: '2026 하계 계절학기' },
      { key: '2025-W', label: '2025 동계 계절학기' },
    ];
    const cases = terms.flatMap((term) => ['midterm', 'final'].map((type, i) => ({
      ...term, type: type as 'midterm' | 'final', id: terms.indexOf(term) * 2 + i + 1000,
    })));
    let active = cases[0];
    let parseCalls = 0;
    let fetchCalls = 0;
    globalThis.fetch = async (input) => {
      fetchCalls++;
      const url = new URL(String(input));
      if (url.pathname.includes('download.php')) return new Response('%PDF fixture');
      return new Response(bneNotice(`${active.label} ${active.type === 'midterm' ? '중간' : '기말'}시험 시간표`, active.id));
    };
    const parser = async (_path: string, input: { term: string; exam_type: string }) => {
      parseCalls++;
      assert.equal(input.term, active.key);
      return parseExamScheduleTsv(tsv([
        word(1, 104, 39, '교양대학'), word(1, 19, 110, '시험과목'), word(1, 166, 110, '01'),
        word(1, 367, 110, '대면시험'), word(1, 491, 110, '2026-01-14'),
        word(1, 591, 110, '10:00'), word(1, 660, 110, '10:50'),
      ]), input);
    };
    const sourceUrl = (id: number) => `https://bne.cau.ac.kr/bneNews/notice/view.php?idx=${id}`;
    const server = createEclassServer({ username: 'test', session: {} as BrowserSession, fileCache: {} as FileCache, examCache: cache });
    const client = new Client({ name: 'semester-test', version: '0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      for (const item of cases) {
        active = item;
        const result = await syncExamSchedules(cache, { term: item.label, exam_type: item.type, source_url: sourceUrl(item.id) }, parser);
        assert.ok(result.ok);
        assert.equal(result.term, item.key);
        assert.equal(result.documents[0].parsed_rows, 1);
        assert.ok(result.documents[0].local_pdf_path.includes(path.join(item.key, item.type)));
      }
      assert.equal(cache.listSchedules({}).length, 8);
      await client.listTools();
      for (const item of cases) {
        const result = await client.callTool({ name: 'eclass_get_exam_schedule', arguments: { term: item.label, exam_type: item.type } });
        assert.equal(result.isError, false);
        const matches = (result.structuredContent as { matches: Array<{ term: string; exam_type: string }> }).matches;
        assert.equal(matches.length, 1);
        assert.equal(matches[0].term, item.key);
        assert.equal(matches[0].exam_type, item.type);
      }
      const again = await syncExamSchedules(cache, { term: active.key, exam_type: active.type, source_url: sourceUrl(active.id) }, parser);
      assert.equal(again.documents[0].diff_status, 'unchanged');
      assert.equal(parseCalls, 8);
      const beforeInvalid = fetchCalls;
      const invalid = await client.callTool({ name: 'eclass_sync_exam_schedules', arguments: { term: '2026 계절학기' } });
      assert.equal(invalid.isError, true);
      assert.equal(invalid.structuredContent?.reason, 'INVALID_EXAM_TERM');
      assert.equal(fetchCalls, beforeInvalid);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousDir === undefined) delete process.env.ECLASS_EXAM_DOWNLOAD_DIR;
      else process.env.ECLASS_EXAM_DOWNLOAD_DIR = previousDir;
      await client.close();
      await server.close();
      cache.getDb().close();
    }
  });
});

test('SIS source IDs preserve seasonal S/W codes for exam course matching', () => {
  assert.equal(parseSisSourceId('2026_S_1_3B510_35703_01')?.term, '2026-S');
  assert.equal(parseSisSourceId('2025_w_1_3B510_27803_01')?.term, '2025-W');
  const result = normalizeSisCourseInfo({ sis_source_id: '2025_W_1_3B510_27803_01', course_code: '경영정보시스템 01분반' });
  assert.ok(result.ok);
  assert.equal(result.info.course_code, '27803');
  assert.equal(result.info.term, '2025-W');
});

test('parseCanvasAccountName parses live account name formats', () => {
  // live 검증된 형태 (2026-06-13): "{단과대} {학부} [{전공}]"
  assert.deepEqual(parseCanvasAccountName('소프트웨어대학 소프트웨어학부'), {
    college: '소프트웨어대학',
    department: '소프트웨어학부',
  });
  assert.deepEqual(parseCanvasAccountName('경영경제대학 경영학부(서울) 경영학'), {
    college: '경영경제대학',
    department: '경영학부(서울)',
  });
  // "대학(전체)"(교양/공통 개설 조직)는 교양대학으로 명시 매핑 → ge_notice 라우팅
  assert.deepEqual(parseCanvasAccountName('대학(전체)'), { college: '교양대학', department: null });
  // 그 외 파싱 불가 형태는 null (원문은 canvas_account_name으로 보존)
  assert.deepEqual(parseCanvasAccountName('중앙대학교'), { college: null, department: null });
  assert.deepEqual(parseCanvasAccountName(null), { college: null, department: null });
  // 객체 프로토타입 속성명과 같은 account 이름은 매핑/파싱되지 않는다
  for (const prototypeKey of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(parseCanvasAccountName(prototypeKey), { college: null, department: null });
  }
});

test('syncCourseMetadata stores learningx_sis result with confirmed fields', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    const client = {
      fetchOne: async () => ({
        id: 10,
        name: '소프트웨어공학',
        course_code: '2026-1-11708-01',
        sis_course_id: '2026-10-11708-01',
        term: { name: '2026년 1학기' },
      }),
      fetchAll: async () => [],
    } as unknown as CanvasClient;

    const result = await syncCourseMetadata(cache, client, { course_id: 10 }, async () => ({
      ok: true,
      endpoint: '/learningx/api/v1/courses/10/sis_course/check',
      info: {
        college: '소프트웨어대학',
        department: '소프트웨어학부',
        instructor: '이찬근',
        course_code: '11708',
        section: '01',
        term: '2026-1',
        raw_sis_course_id: '2026-10-11708-01',
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.synced.length, 1);
    assert.equal(result.synced[0].source, 'learningx_sis');
    assert.equal(result.synced[0].college, '소프트웨어대학');
    assert.equal(result.synced[0].course_code, '11708');
    assert.equal(result.synced[0].section, '01');
    // term은 SIS 확정값("2026-1")이 Canvas "2026년 1학기"를 덮어쓴다
    assert.equal(result.synced[0].term, '2026-1');
    cache.getDb().close();
  });
});

test('syncCourseMetadata falls back to canvas_only and preserves Canvas fields', async () => {
  await withTempExamDb(async () => {
    const cache = new ExamCache();
    const client = {
      fetchOne: async () => ({
        id: 20,
        name: '일반물리(1) 03분반',
        course_code: '2026-1-39202-03',
        sis_course_id: '2026-20-39202-03',
        term: { name: '2026년 1학기' },
        teachers: [{ display_name: '홍길동 / Gil Dong Hong' }],
        account: { name: '소프트웨어대학 소프트웨어학부' },
      }),
      fetchAll: async () => [],
    } as unknown as CanvasClient;

    const result = await syncCourseMetadata(cache, client, { course_id: 20 }, async () => ({
      ok: false,
      error_code: 'SIS_ENDPOINT_UNAVAILABLE',
      message: 'LearningX API error 404',
    }));
    assert.equal(result.ok, true);
    const record = result.synced[0];
    assert.equal(record.source, 'canvas_only');
    // SIS 실패여도 Canvas account/teachers 기반 사실값은 채운다
    assert.equal(record.college, '소프트웨어대학');
    assert.equal(record.department, '소프트웨어학부');
    assert.equal(record.instructor, '홍길동 / Gil Dong Hong');
    assert.equal(record.canvas_account_name, '소프트웨어대학 소프트웨어학부');
    assert.equal(record.course_code, null);
    assert.equal(record.section, null);
    assert.equal(record.canvas_course_code, '2026-1-39202-03');
    assert.equal(record.canvas_sis_course_id, '2026-20-39202-03');
    // canvas_only는 SIS 확정 term이 없으므로 Canvas term을 그대로 유지
    assert.equal(record.term, '2026년 1학기');
    assert.match(record.sis_error ?? '', /SIS_ENDPOINT_UNAVAILABLE/);
    cache.getDb().close();
  });
});

test('selectSourcesForCourse filters by confirmed college only', () => {
  const sources = BUILTIN_EXAM_SOURCES;
  assert.deepEqual(
    selectSourcesForCourse(sources, { college: '소프트웨어대학', department: '소프트웨어학부' }).map((s) => s.college),
    ['소프트웨어대학'],
  );
  // 교양과목("대학(전체)"→교양대학 매핑)은 ge_notice로 정확히 라우팅
  assert.deepEqual(
    selectSourcesForCourse(sources, { college: '교양대학', department: null }).map((s) => s.college),
    ['교양대학'],
  );
  // canvas_only(미확정)는 전체 소스 반환
  assert.equal(selectSourcesForCourse(sources, { college: null, department: null }).length, sources.length);
  assert.equal(selectSourcesForCourse(sources, undefined).length, sources.length);
  // 등록 안 된 단과대도 전체 반환 (강의명 추론 없음)
  assert.equal(selectSourcesForCourse(sources, { college: '자연과학대학', department: null }).length, sources.length);
});
