import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { sanitizeFileName, expandTilde } from '../../utils.js';
import type { ExamSourceRecord, ExamType } from '../../exam-cache.js';
import { extractExamTerms, normalizeExamTerm, parseExamTerm } from '../../academic-term.js';

const REQUEST_TIMEOUT_MS = 30_000;
const SOURCE_LIST_URL = 'https://www.cau.ac.kr/cms/FR_CON/index.do?MENU_ID=800';
const MAX_NOTICE_SEARCH_PAGES = 20;

export interface ExamNoticeFilter {
  term: string;
  exam_type: ExamType;
}

export interface ParsedNoticeDocument {
  notice_url: string;
  title: string;
  posted_at: string | null;
  body_text: string;
  body_hash: string;
  attachment_url: string;
  attachment_name: string;
}

export interface DownloadedNoticeDocument extends ParsedNoticeDocument {
  file_hash: string;
  local_pdf_path: string;
  size_bytes: number;
}

export interface NoticeFetchIssue {
  scope: string;
  reason: string;
  retryable: boolean;
}

export const BUILTIN_EXAM_SOURCES: ExamSourceRecord[] = [
  {
    college: '교양대학',
    department: null,
    homepage_url: 'https://ge.cau.ac.kr/',
    notice_board_url: 'https://ge.cau.ac.kr/board_notice.php',
    adapter_type: 'ge_notice',
  },
  {
    college: '소프트웨어대학',
    department: '소프트웨어학부',
    homepage_url: 'https://cse.cau.ac.kr/',
    notice_board_url: 'https://cse.cau.ac.kr/sub05/sub0501.php',
    adapter_type: 'cse_notice',
  },
  {
    college: '경영경제대학',
    department: null,
    homepage_url: 'https://bne.cau.ac.kr/',
    notice_board_url: 'https://bne.cau.ac.kr/bneNews/notice/list.php',
    adapter_type: 'bne_notice',
  },
];

function isAllowedPublicCauUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      (url.hostname === 'cau.ac.kr' || url.hostname === 'www.cau.ac.kr' || url.hostname.endsWith('.cau.ac.kr'));
  } catch {
    return false;
  }
}

function assertAllowedPublicCauUrl(rawUrl: string): void {
  if (!isAllowedPublicCauUrl(rawUrl)) {
    throw new Error(`Public CAU URL rejected: ${rawUrl}`);
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function matchesExamIdentity(text: string, input: ExamNoticeFilter): boolean {
  const compact = text.replace(/\s+/g, '').toLowerCase();
  const expected = parseExamTerm(input.term);
  if (!expected) return false;
  const terms = extractExamTerms(text);
  if (terms.length === 0 || terms.some((term) => term.canonical !== expected.canonical)) return false;
  const hasMidterm = /중간|mid[-_]?term/.test(compact);
  const hasFinal = /기말|final/.test(compact);
  return input.exam_type === 'midterm' ? hasMidterm : hasFinal;
}

export function matchesExamNotice(document: ParsedNoticeDocument, input: ExamNoticeFilter): boolean {
  const text = `${document.title} ${document.attachment_name}`;
  const conflictingType = [document.title, document.attachment_name].some((part) => {
    const midterm = /중간|mid[-_]?term/i.test(part);
    const final = /기말|final/i.test(part);
    return input.exam_type === 'midterm' ? final && !midterm : midterm && !final;
  });
  return !conflictingType && matchesExamIdentity(text, input) && /시간표|timetable|schedule/i.test(text);
}

function selectNoticeDocument(documents: ParsedNoticeDocument[], input?: ExamNoticeFilter): ParsedNoticeDocument | null {
  const matching = input ? documents.filter((document) => matchesExamNotice(document, input)) : documents;
  return matching.find((document) => /시간표|timetable|schedule/i.test(document.attachment_name)) ?? matching[0] ?? null;
}

function firstMatch(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  return match ? decodeHtmlEntities(match[1]).trim() : null;
}

function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function absoluteUrl(baseUrl: string, href: string): string {
  return new URL(decodeHtmlEntities(href).trim(), baseUrl).toString();
}

async function fetchText(url: string): Promise<string> {
  assertAllowedPublicCauUrl(url);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/pdf,application/octet-stream',
      'User-Agent': 'eclass-mcp/0.1 exam-schedule-sync',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  assertAllowedPublicCauUrl(url);
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/pdf,application/octet-stream,*/*',
      'User-Agent': 'eclass-mcp/0.1 exam-schedule-sync',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function parseGeNoticeHtml(html: string, noticeUrl: string, input?: ExamNoticeFilter): ParsedNoticeDocument | null {
  const title = firstMatch(html, /<p class="tit">[\s\S]*?<strong>([\s\S]*?)<\/strong>/i)
    ?? firstMatch(html, /<title>([\s\S]*?)<\/title>/i)
    ?? '교양대학 시험 공지';
  const postedAt = firstMatch(html, /<li><strong>작성일<\/strong><span class="r">([^<]+)<\/span><\/li>/i);
  const bodyHtml = firstMatch(html, /<div class="view_con">([\s\S]*?)<\/div>\s*<!-- \/\/ view_con -->/i) ?? '';
  const filesHtml = firstMatch(html, /<div class="view_file">([\s\S]*?)(?=<div class="view_con">|$)/i) ?? '';
  const filePattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>[\s\S]*?<\/a>/gi;
  const documents: ParsedNoticeDocument[] = [];
  for (const match of filesHtml.matchAll(filePattern)) {
    const attachmentName = stripHtml(match[2]);
    if (!/\.pdf$/i.test(attachmentName)) continue;
    const document = {
      notice_url: noticeUrl, title, posted_at: postedAt,
      body_text: stripHtml(bodyHtml), body_hash: sha256(stripHtml(bodyHtml)),
      attachment_url: absoluteUrl(noticeUrl, match[1]), attachment_name: attachmentName,
    };
    documents.push(document);
  }
  return selectNoticeDocument(documents, input);
}

export function parseCseNoticeHtml(html: string, noticeUrl: string, input?: ExamNoticeFilter): ParsedNoticeDocument | null {
  const title = firstMatch(html, /<div class="header">\s*<h3>([\s\S]*?)<\/h3>/i)
    ?? firstMatch(html, /<title>([\s\S]*?)<\/title>/i)
    ?? '소프트웨어대학 시험 공지';
  const postedAt = firstMatch(html, /<div class="header">[\s\S]*?<span>(\d{4}-\d{2}-\d{2})<\/span>/i);
  const bodyHtml = firstMatch(html, /<div class="detail">([\s\S]*?)<!--<!-- 덧글 Start -->/i)
    ?? firstMatch(html, /<div class="detail">([\s\S]*?)<\/div>\s*<\/div>/i)
    ?? '';
  const filePattern = /goLocation\('([^']+)','([^']+)','([^']+)'\)[^>]*>([^<]+\.pdf)\s*<\/span>/gi;
  const documents: ParsedNoticeDocument[] = [];
  for (const match of html.matchAll(filePattern)) {
    const attachmentUrl = absoluteUrl(noticeUrl, `${match[1]}?uid=${encodeURIComponent(match[2])}&code=${encodeURIComponent(match[3])}`);
    const document = {
      notice_url: noticeUrl, title, posted_at: postedAt,
      body_text: stripHtml(bodyHtml), body_hash: sha256(stripHtml(bodyHtml)),
      attachment_url: attachmentUrl, attachment_name: stripHtml(match[4]),
    };
    documents.push(document);
  }
  return selectNoticeDocument(documents, input);
}

export function parseGenericNoticeHtml(html: string, noticeUrl: string, input?: ExamNoticeFilter): ParsedNoticeDocument | null {
  const title = firstMatch(html, /<h[123][^>]*>([^<]*(?:중간|기말|시험|시간표)[^<]*)<\/h[123]>/i)
    ?? firstMatch(html, /<title>([\s\S]*?)<\/title>/i)
    ?? '시험 공지';
  const postedAt = firstMatch(html, /(\d{4}[-.]\d{2}[-.]\d{2})/);
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const documents: ParsedNoticeDocument[] = [];
  for (const match of html.matchAll(anchorPattern)) {
    const text = stripHtml(match[2]);
    const href = decodeHtmlEntities(match[1]);
    const target = `${text} ${href}`.toLowerCase();
    if (!target.includes('pdf') && !target.includes('download')) continue;
    if (!/(중간|기말|시험|시간표|midterm|final|exam)/i.test(target)) continue;
    const document = {
      notice_url: noticeUrl,
      title,
      posted_at: postedAt?.replaceAll('.', '-') ?? null,
      body_text: stripHtml(html),
      body_hash: sha256(stripHtml(html)),
      attachment_url: absoluteUrl(noticeUrl, href),
      attachment_name: text || path.basename(href),
    };
    documents.push(document);
  }
  return selectNoticeDocument(documents, input);
}

export function parseBneNoticeHtml(html: string, noticeUrl: string, input?: ExamNoticeFilter): ParsedNoticeDocument | null {
  const title = firstMatch(html, /<th\b[^>]*class="tit"[^>]*>([\s\S]*?)<\/th>/i) ?? '경영경제대학 시험 공지';
  const postedAt = firstMatch(html, /<th>작성일<\/th>\s*<td>([^<]+)<\/td>/i)?.replaceAll('.', '-') ?? null;
  const body = stripHtml(firstMatch(html, /<div class="viewCont">([\s\S]*?)<\/div>/i) ?? '');
  const files = firstMatch(html, /<ul class="fileList">([\s\S]*?)<\/ul>/i) ?? '';
  const documents: ParsedNoticeDocument[] = [];
  for (const match of files.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const name = stripHtml(match[2]);
    if (!/\.pdf$/i.test(name)) continue;
    documents.push({
      notice_url: noticeUrl, title: stripHtml(title), posted_at: postedAt,
      body_text: body, body_hash: sha256(body),
      attachment_url: absoluteUrl(noticeUrl, match[1]), attachment_name: name,
    });
  }
  return selectNoticeDocument(documents, input);
}

export function parseNoticeHtml(html: string, noticeUrl: string, adapterType: string, input?: ExamNoticeFilter): ParsedNoticeDocument | null {
  if (adapterType === 'ge_notice') return parseGeNoticeHtml(html, noticeUrl, input);
  if (adapterType === 'cse_notice') return parseCseNoticeHtml(html, noticeUrl, input);
  if (adapterType === 'bne_notice') return parseBneNoticeHtml(html, noticeUrl, input);
  return parseGenericNoticeHtml(html, noticeUrl, input);
}

export function parseExamNoticeLinks(html: string, boardUrl: string, input: ExamNoticeFilter): string[] {
  const links = new Map<number, string>();
  const board = new URL(boardUrl);
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const title = stripHtml(match[2]);
    if (!matchesExamIdentity(title, input) || !/시간표|수정|변경|재공지|timetable|schedule/i.test(title)) continue;
    // 기본 교양 소스는 기존과 동일하게 서울캠퍼스 시간표를 사용한다.
    if (board.hostname === 'ge.cau.ac.kr' && /다빈치|안성/.test(title)) continue;
    const url = new URL(absoluteUrl(boardUrl, match[1]));
    if (url.origin !== board.origin) continue;
    const idParam = board.hostname === 'ge.cau.ac.kr' ? 'no' : board.hostname === 'bne.cau.ac.kr' ? 'idx' : 'uid';
    const id = Number(url.searchParams.get(idParam));
    if (!Number.isInteger(id) || id <= 0) continue;
    links.set(id, url.toString());
  }
  return [...links].sort(([a], [b]) => b - a).map(([, url]) => url);
}

export async function fetchNoticeDocument(source: ExamSourceRecord, input?: ExamNoticeFilter): Promise<ParsedNoticeDocument | null> {
  const board = new URL(source.notice_board_url);
  const isGeBoard = source.adapter_type === 'ge_notice' && board.pathname.endsWith('/board_notice.php');
  const isCseBoard = source.adapter_type === 'cse_notice' && !board.searchParams.has('uid');
  const isBneBoard = source.adapter_type === 'bne_notice' && board.pathname.endsWith('/list.php');
  if (!input || (!isGeBoard && !isCseBoard && !isBneBoard)) {
    const html = await fetchText(source.notice_board_url);
    return parseNoticeHtml(html, source.notice_board_url, source.adapter_type, input);
  }

  const semester = parseExamTerm(input.term)?.semester;
  const keyword = semester === 'S' || semester === 'W' ? '계절' : input.exam_type === 'midterm' ? '중간' : '기말';
  board.searchParams.set(isGeBoard ? 'f_part' : isBneBoard ? 's_key' : 'search', isGeBoard ? 'subject' : isBneBoard ? 'TITLE' : 'title');
  board.searchParams.set(isGeBoard ? 'f_word' : isBneBoard ? 's_word' : 'keyword', keyword);
  if (isCseBoard) {
    board.searchParams.set('nmode', 'list');
    board.searchParams.set('code', 'oktomato_bbs05');
  }
  const visited = new Set<string>();
  for (let page = 1; page <= MAX_NOTICE_SEARCH_PAGES; page++) {
    board.searchParams.set(isCseBoard ? 'offset' : 'page', String(page));
    const html = await fetchText(board.toString());
    const links = parseExamNoticeLinks(html, board.toString(), input).filter((url) => !visited.has(url));
    for (const url of links) {
      visited.add(url);
      const noticeHtml = await fetchText(url);
      const document = parseNoticeHtml(noticeHtml, url, source.adapter_type, input);
      if (document) return document;
    }
    const nextParam = isCseBoard ? 'offset' : 'page';
    const nextPattern = new RegExp(`${nextParam}=${page + 1}(?:&|["'])`);
    if (!nextPattern.test(html)) return null;
  }
  throw new Error(`EXAM_NOTICE_SEARCH_LIMIT: ${source.notice_board_url}`);
}

export async function downloadNoticePdf(
  document: ParsedNoticeDocument,
  input: { term: string; exam_type: string; download_dir?: string },
): Promise<DownloadedNoticeDocument> {
  const term = normalizeExamTerm(input.term);
  const buffer = await fetchBuffer(document.attachment_url);
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error('Downloaded attachment is not a PDF');
  }
  const safeName = sanitizeFileName(document.attachment_name) ?? `${sha256(document.attachment_url).slice(0, 12)}.pdf`;
  const dir = path.join(
    expandTilde(input.download_dir ?? process.env.ECLASS_EXAM_DOWNLOAD_DIR ?? '~/Downloads/eclass-exams'),
    term,
    input.exam_type,
  );
  await fs.mkdir(dir, { recursive: true });
  const localPath = path.join(dir, safeName.toLowerCase().endsWith('.pdf') ? safeName : `${safeName}.pdf`);
  await fs.writeFile(localPath, buffer);
  return {
    ...document,
    file_hash: sha256(buffer),
    local_pdf_path: localPath,
    size_bytes: buffer.length,
  };
}

export async function discoverExamSources(): Promise<{ sources: ExamSourceRecord[]; issues: NoticeFetchIssue[] }> {
  const sources = [...BUILTIN_EXAM_SOURCES];
  const issues: NoticeFetchIssue[] = [];
  try {
    const html = await fetchText(SOURCE_LIST_URL);
    const collegeLinkPattern = /<a\s+[^>]*href=["']([^"']*MENU_ID=\d+[^"']*)["'][^>]*title=["']([^"']*대학[^"']*)["'][^>]*>/gi;
    for (const match of html.matchAll(collegeLinkPattern)) {
      const college = decodeHtmlEntities(match[2]).replace(/\s+/g, ' ').trim();
      if (!college || sources.some((s) => s.college === college)) continue;
      const noticeBoardUrl = absoluteUrl(SOURCE_LIST_URL, match[1]);
      sources.push({
        college,
        department: null,
        homepage_url: noticeBoardUrl,
        notice_board_url: noticeBoardUrl,
        adapter_type: 'generic_cau_college_page',
      });
    }
  } catch (err) {
    issues.push({
      scope: SOURCE_LIST_URL,
      reason: err instanceof Error ? err.message : String(err),
      retryable: true,
    });
  }
  return { sources, issues };
}

// SIS 확정 college/department로만 소스를 좁힌다. college가 없으면(canvas_only) 전체를 본다.
export function selectSourcesForCourse(
  allSources: ExamSourceRecord[],
  course: { college?: string | null; department?: string | null } | undefined,
): ExamSourceRecord[] {
  if (!course?.college && !course?.department) return allSources;
  const selected = allSources.filter((source) =>
    (course.college !== null && course.college !== undefined && source.college === course.college) ||
    (course.department !== null && course.department !== undefined && source.department === course.department),
  );
  return selected.length > 0 ? selected : allSources;
}
