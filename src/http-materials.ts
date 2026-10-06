import { isStreamingMediaType } from './media-types.js';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpSession, isAllowedHttpDestination, htmlAttributes, parseHtmlForm, type HttpResult } from './http-session.js';
import { acquireLearningxToken, fetchLearningxModules } from './learningx-client.js';
import type { CanvasClient } from './canvas-client.js';
import { classifyHttpArtifact, isOcsViewerUrl, type LaunchArtifact } from './external-tool-launch.js';
import { AcquisitionError, acquisitionError } from './material-acquisition.js';
import { extractOcsContentId } from './tools/download-video.js';
import { resolveDownloadFilename } from './download-filename.js';
import { expandTilde, materialStorageKey, sanitizeFileName } from './utils.js';
const BASE_URL = 'https://eclass3.cau.ac.kr';
const MAX_LAUNCH_PAGES = 40;
interface LearningxBoardAttachment { filename?: string; url?: string; canvas_file_id?: number | string }
interface LearningxBoardPostDetail { attachments?: LearningxBoardAttachment[] }
interface LearningxModuleItem {
  module_item_id?: unknown;
  content_id?: unknown;
  content_data?: {
    item_content_type?: unknown;
    lecture_period_status?: unknown;
    item_content_data?: { content_id?: unknown; content_type?: unknown };
  };
}

export interface LearningxBoardLocation {
  boardId: string;
  postId?: string;
}

export function parseLearningxBoardLocation(rawUrl: string): LearningxBoardLocation | null {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== BASE_URL) return null;
    const match = url.pathname.match(
      /^\/learningx\/lti\/learningx_board\/boards\/(\d+)(?:\/posts\/(\d+))?\/?$/,
    );
    if (!match) return null;
    return { boardId: match[1], ...(match[2] ? { postId: match[2] } : {}) };
  } catch {
    return null;
  }
}

function filenameExtension(filename: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match?.[1].toLowerCase();
}

function canvasFileIdFromUrl(rawUrl: string): string | null {
  try {
    const match = new URL(rawUrl).pathname.match(/\/files\/(\d+)(?:\/download)?\/?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parseLearningxBoardPostAttachment(body: unknown): LaunchArtifact | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const detail = body as LearningxBoardPostDetail;
  if (!Array.isArray(detail.attachments)) return null;

  for (const attachment of detail.attachments) {
    if (!attachment || typeof attachment !== 'object') continue;
    if (typeof attachment.url !== 'string' || typeof attachment.filename !== 'string') continue;
    const filename = attachment.filename.trim();
    if (!filename) continue;
    let attachmentUrl: URL;
    try {
      attachmentUrl = new URL(attachment.url, BASE_URL);
    } catch {
      continue;
    }
    if (attachmentUrl.origin !== BASE_URL) continue;
    const fileId = attachment.canvas_file_id !== undefined
      ? String(attachment.canvas_file_id)
      : canvasFileIdFromUrl(attachmentUrl.toString());
    if (!fileId || !/^\d+$/.test(fileId)) continue;

    return {
      kind: 'file',
      url: attachmentUrl.toString(),
      type: filenameExtension(filename),
      filename,
    };
  }

  return null;
}

function xmlText(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}\\b[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${name}>`, 'i').exec(xml);
  return match ? htmlAttributes(`value="${(match[1] ?? match[2]).trim().replace(/"/g, '&quot;')}"`).value : null;
}

/** UniPlayer sharedocs metadata exposes the original document, not rendered pages. */
export function parseOcsDocumentUrl(contentId: string, xml: string): string {
  if (xmlText(xml, 'content_id') !== contentId || xmlText(xml, 'content_type') !== 'sharedocs') {
    throw new AcquisitionError('OCS_DOCUMENT_UNSUPPORTED', 'OCS metadata is not a matching document', false);
  }
  const raw = xmlText(xml, 'content_download_uri');
  if (!raw) throw new AcquisitionError('OCS_DOCUMENT_UNSUPPORTED', 'OCS document download locator missing', false);
  const u = new URL(raw, 'https://ocs.cau.ac.kr');
  if (u.origin !== 'https://ocs.cau.ac.kr' || u.username || u.password || u.pathname !== '/index.php'
      || u.searchParams.get('module') !== 'xn_media_content2013'
      || u.searchParams.get('act') !== 'dispXn_media_content2013DownloadWebFile'
      || u.searchParams.get('content_id') !== contentId) {
    throw new AcquisitionError('OCS_DOCUMENT_UNSUPPORTED', 'OCS document download locator rejected', false);
  }
  return u.href;
}

/** Older OCS File viewers (type 17) expose a literal original-file download URL. */
export function parseOcsFileViewerUrl(contentId: string, html: string): string {
  const id = /\bvar\s+content_id\s*=\s*(['"])([^'"]+)\1/.exec(html)?.[2];
  const player = /\bvar\s+playerType\s*=\s*(['"])([^'"]+)\1/.exec(html)?.[2];
  const type = /\bvar\s+content_type\s*=\s*(['"])([^'"]+)\1/.exec(html)?.[2];
  if (id !== contentId || player !== 'File' || type !== '17') {
    throw new AcquisitionError('OCS_DOCUMENT_UNSUPPORTED', 'OCS viewer is not a matching original file', false);
  }
  for (const match of html.matchAll(/\.attr\(\s*['"]src['"]\s*,\s*(['"])([^'"]+)\1\s*\)/g)) {
    const raw = htmlAttributes(`value="${match[2].replace(/"/g, '&quot;')}"`).value;
    try {
      const url = new URL(raw, 'https://ocs.cau.ac.kr');
      if (url.origin === 'https://ocs.cau.ac.kr' && !url.username && !url.password
          && url.pathname === '/index.php' && url.searchParams.get('module') === 'xn_media_content2013'
          && url.searchParams.get('act') === 'dispXn_media_content2013DownloadContent'
          && url.searchParams.get('content_id') === contentId) return url.href;
    } catch { /* Not a matching file locator. */ }
  }
  throw new AcquisitionError('OCS_DOCUMENT_UNSUPPORTED', 'OCS original file locator missing', false);
}

async function resolveLegacyOcsFile(session: HttpSession, id: string): Promise<string> {
  const viewer = await session.request(`https://ocs.cau.ac.kr/em/${encodeURIComponent(id)}`);
  if (!viewer.ok) throw new AcquisitionError('OCS_METADATA_HTTP_ERROR', `OCS viewer HTTP ${viewer.status}`, viewer.status === 429 || viewer.status >= 500);
  return parseOcsFileViewerUrl(id, viewer.text);
}

async function readOcsMetadata(session: HttpSession, id: string): Promise<HttpResult> {
  const metadata = await session.request(`https://ocs.cau.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=${encodeURIComponent(id)}`);
  if (!metadata.ok) throw new AcquisitionError('OCS_METADATA_HTTP_ERROR', `OCS metadata HTTP ${metadata.status}`, metadata.status === 429 || metadata.status >= 500);
  if (/<html\b/i.test(metadata.text) && /API Request fail/i.test(metadata.text)) {
    throw new AcquisitionError('OCS_UPSTREAM_UNAVAILABLE', 'OCS returned an upstream API failure page', true);
  }
  return metadata;
}

// Missing UniPlayer structure may indicate a legacy viewer; the viewer itself
// must still prove the requested identity, File/type 17 and download destination.
function needsLegacyViewer(metadata: HttpResult): boolean {
  return !/<content_id\b/i.test(metadata.text);
}

export async function downloadOcsDocument(
  courseId: number, resourceId: string, displayName: string, downloadDir: string, viewUrl: string,
  session: HttpSession,
): Promise<string> {
  const safeName = sanitizeFileName(displayName);
  if (!safeName) throw new Error('Invalid document filename');
  const id = extractOcsContentId(viewUrl);
  const metadata = await readOcsMetadata(session, id);
  const url = needsLegacyViewer(metadata)
    ? await resolveLegacyOcsFile(session, id) : parseOcsDocumentUrl(id, metadata.text);
  const { response } = await session.open(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new AcquisitionError('OCS_DOCUMENT_HTTP_ERROR', `OCS document HTTP ${response.status}`, response.status === 429 || response.status >= 500);
  }
  const ct = (response.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/html') || ct.startsWith('video/') || ct.includes('mpegurl')) {
    await response.body.cancel();
    throw new AcquisitionError('OCS_DOCUMENT_UNSUPPORTED', 'OCS download did not return a document', false);
  }
  const dir = path.join(expandTilde(downloadDir), String(courseId), materialStorageKey(resourceId));
  const name = resolveDownloadFilename(safeName, { contentDisposition: response.headers.get('content-disposition') ?? undefined, contentType: ct });
  await fs.mkdir(dir, { recursive: true });
  const destination = path.join(dir, name), temporary = `${destination}.${randomUUID()}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(temporary, { flags: 'wx' }));
    if ((await fs.stat(temporary)).size === 0) throw new Error('Empty OCS document');
    await fs.rename(temporary, destination);
    return destination;
  } finally { await fs.rm(temporary, { force: true }); }
}

async function resolveOcsArtifact(session: HttpSession, url: string): Promise<LaunchArtifact> {
  const id = extractOcsContentId(url);
  const metadata = await readOcsMetadata(session, id);
  if (needsLegacyViewer(metadata)) {
    await resolveLegacyOcsFile(session, id);
    return { kind: 'ocs_viewer', url, type: 'file' };
  }
  if (xmlText(metadata.text, 'content_id') !== id) throw new AcquisitionError('EXTERNAL_TOOL_PROTOCOL_ERROR', 'OCS content identity mismatch', false);
  const type = xmlText(metadata.text, 'content_type');
  if (type === 'sharedocs') { parseOcsDocumentUrl(id, metadata.text); return { kind: 'ocs_viewer', url, type: 'file' }; }
  if (isStreamingMediaType(type)) return { kind: 'video', url, type: 'video' };
  return { kind: 'ocs_viewer', url, type: 'ocs' };
}

async function learningxJson(session: HttpSession, url: string, client: CanvasClient, courseId: number, signal?: AbortSignal): Promise<unknown> {
  const u = new URL(url);
  if (u.origin !== BASE_URL || !u.pathname.startsWith('/learningx/api/v1/')) throw new Error('Invalid LearningX endpoint');
  const cookie = session.cookieValue('xn_api_token', url);
  let cookieToken: string | undefined;
  try { cookieToken = cookie ? decodeURIComponent(cookie) : undefined; } catch { /* Acquire a fresh token if the cookie encoding is malformed. */ }
  signal?.throwIfAborted();
  const token = cookieToken ?? await acquireLearningxToken(client, courseId);
  signal?.throwIfAborted();
  let r = await session.request(url, { signal, headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, false);
  if (r.status === 401 && cookieToken) {
    const renewed = await acquireLearningxToken(client, courseId);
    r = await session.request(url, { signal, headers: { Accept: 'application/json', Authorization: `Bearer ${renewed}` } }, false);
  }
  if (!r.ok) throw new AcquisitionError('EXTERNAL_TOOL_HTTP_ERROR', `LearningX HTTP ${r.status}`, r.status === 401 || r.status === 429 || r.status >= 500);
  try { return JSON.parse(r.text); } catch { throw new AcquisitionError('EXTERNAL_TOOL_PROTOCOL_ERROR', 'Invalid LearningX JSON', false); }
}

async function boardAttachment(session: HttpSession, client: CanvasClient, courseId: number, board: LearningxBoardLocation): Promise<LaunchArtifact | null> {
  const signal = AbortSignal.timeout(60_000);
  let details = 0;
  const read = async (url: string): Promise<unknown> => {
    let onAbort: () => void = () => {};
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AcquisitionError('EXTERNAL_TOOL_TIMEOUT', 'LearningX board deadline exceeded', true));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try { return await Promise.race([timeout, learningxJson(session, url, client, courseId, signal)]); }
    finally { signal.removeEventListener('abort', onAbort); }
  };
  const root = `${BASE_URL}/learningx/api/v1/learningx_board/courses/${courseId}/boards/${board.boardId}/posts`;
  if (board.postId) return parseLearningxBoardPostAttachment(await read(`${root}/${board.postId}`));
  for (let page = 1; page <= 20; page++) {
    const body = await read(`${root}?page=${page}&per_page=100`) as { items?: unknown[]; pagination?: { last_page?: number; current_page?: number; total?: number } };
    if (!body || !Array.isArray(body.items)) throw new AcquisitionError('EXTERNAL_TOOL_PROTOCOL_ERROR', 'Invalid LearningX board list', false);
    for (const item of body.items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { id?: unknown; attachment_count?: unknown; is_secret?: unknown };
      if (row.is_secret === true || row.attachment_count === 0) continue;
      if (!/^\d+$/.test(String(row.id))) throw new AcquisitionError('EXTERNAL_TOOL_PROTOCOL_ERROR', 'Invalid LearningX post identity', false);
      if (++details > 50) throw new AcquisitionError('EXTERNAL_TOOL_LIMIT_REACHED', 'LearningX board detail limit reached', false);
      const artifact = parseLearningxBoardPostAttachment(await read(`${root}/${row.id}`));
      if (artifact) return artifact.kind === 'ocs_viewer' ? await resolveOcsArtifact(session, artifact.url) : artifact;
    }
    // Follow the server's page count. Without pagination, this is a complete list.
    const total = body.pagination?.last_page;
    if (total !== undefined && (!Number.isInteger(total) || total < 1)) throw new AcquisitionError('EXTERNAL_TOOL_PROTOCOL_ERROR', 'Invalid LearningX pagination', false);
    if (total === undefined || page >= total || body.items.length === 0) return null;
  }
  throw new AcquisitionError('EXTERNAL_TOOL_LIMIT_REACHED', 'LearningX board pagination limit reached', false);
}

async function launchPage(session: HttpSession, url: string, init: RequestInit = {}): Promise<HttpResult> {
  const opened = await session.open(url, init);
  const { response } = opened;
  const result = { url: opened.url, status: response.status, ok: response.ok, headers: response.headers, text: '' };
  const artifact = classifyHttpArtifact({ url: result.url, status: result.status,
    contentType: result.headers.get('content-type') ?? undefined, contentDisposition: result.headers.get('content-disposition') ?? undefined });
  if (artifact && artifact.kind !== 'ocs_viewer') { await response.body?.cancel(); return result; }
  const chunks: Uint8Array[] = []; let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new AcquisitionError('EXTERNAL_TOOL_PROTOCOL_ERROR', 'Oversized LTI page', false);
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
  }
  result.text = Buffer.concat(chunks).toString('utf8');
  return result;
}

/** A retryable branch may still contain the artifact; within that class prefer
 * actionable protocol/type diagnostics over HTTP status and generic errors. */
function selectLaunchFailure(failures: unknown[]): unknown {
  const score = (failure: unknown): number => {
    const detail = acquisitionError(failure);
    const specificity = detail.code === 'DOWNLOAD_FAILED' ? 0
      : detail.code.endsWith('PROTOCOL_ERROR') ? 3
      : detail.code.endsWith('HTTP_ERROR') ? 1 : 2;
    return (detail.retryable ? 10 : 0) + specificity;
  };
  return failures.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best);
}

/** Follows only known LTI forms, iframe targets and literal redirects; never runs page scripts. */
export async function resolveHttpExternalTool(
  session: HttpSession, client: CanvasClient, courseId: number, moduleItemUrl: string,
): Promise<LaunchArtifact> {
  const start = new URL(moduleItemUrl);
  if (isOcsViewerUrl(start.href)) return resolveOcsArtifact(session, start.href);
  if (start.origin !== BASE_URL || !new RegExp(`^/courses/${courseId}/(?:modules/items/\\d+|external_tools/\\d+)/?$`).test(start.pathname)) {
    throw new AcquisitionError('EXTERNAL_TOOL_INVALID_URL', 'ExternalTool course locator rejected', false);
  }
  const pending: Array<{ url: string; init?: RequestInit }> = [{ url: start.href }];
  const visited = new Set<string>();
  const failures: unknown[] = [];
  let pages = 0;
  while (pending.length && pages < MAX_LAUNCH_PAGES) {
    const entry = pending.shift()!;
    const key = `${entry.init?.method ?? 'GET'}:${entry.url}`;
    if (visited.has(key)) continue;
    visited.add(key);
    pages++;
    try {
      if (isOcsViewerUrl(entry.url)) return await resolveOcsArtifact(session, entry.url);
      const result = await launchPage(session, entry.url, entry.init);
      if (entry.init?.method !== 'POST') visited.add(`GET:${result.url}`);
      if (!result.ok) throw new AcquisitionError('EXTERNAL_TOOL_HTTP_ERROR', `ExternalTool HTTP ${result.status}`, result.status === 401 || result.status === 429 || result.status >= 500);
      if (new URL(result.url).pathname === '/login' || result.text.includes('login_user_password')) {
        throw new AcquisitionError('EXTERNAL_TOOL_SESSION_EXPIRED', 'ExternalTool authentication session expired', true);
      }
      const artifact = classifyHttpArtifact({ url: result.url, status: result.status,
        contentType: result.headers.get('content-type') ?? undefined, contentDisposition: result.headers.get('content-disposition') ?? undefined });
      if (artifact) return artifact.kind === 'ocs_viewer' ? await resolveOcsArtifact(session, artifact.url) : artifact;
      const board = parseLearningxBoardLocation(result.url);
      if (board) {
        const found = await boardAttachment(session, client, courseId, board);
        if (found) return found;
        continue;
      }
      // Lecture wrappers expose their content through the same modules read endpoint.
      const lecture = /^\/learningx\/lti\/lecture_attendance\/items\/view\/(\d+)$/.exec(new URL(result.url).pathname);
      if (lecture) {
        const modules = await fetchLearningxModules(client, courseId);
        const itemId = /\/modules\/items\/(\d+)/.exec(start.pathname)?.[1];
        for (const rawModule of modules) {
          if (!rawModule || typeof rawModule !== 'object') continue;
          const items = (rawModule as { module_items?: unknown }).module_items;
          if (!Array.isArray(items)) continue;
          for (const rawItem of items) {
            if (!rawItem || typeof rawItem !== 'object') continue;
            const item = rawItem as LearningxModuleItem;
            if (itemId ? String(item.module_item_id) !== itemId : String(item.content_id) !== lecture[1]) continue;
            const data = item.content_data;
            const content = data?.item_content_data;
            if (String(data?.lecture_period_status ?? '').trim().toLowerCase() === 'not_open' || String(content?.content_id ?? '').trim().toLowerCase() === 'not_open') throw new AcquisitionError('MATERIAL_NOT_OPEN', 'LearningX material is not open', false);
            if (data?.item_content_type === 'commons' && content && typeof content.content_id === 'string' && /^[\w-]+$/.test(content.content_id)) {
              const url = `https://ocs.cau.ac.kr/em/${content.content_id}`;
              const type = String(content.content_type ?? '').trim().toLowerCase();
              return isStreamingMediaType(type) ? { kind: 'video', url, type } : { kind: 'ocs_viewer', url, type };
            }
          }
        }
        continue;
      }
      let form;
      try { form = parseHtmlForm(result.text, f => f.method === 'POST' && f.fields.has('lti_message_type')); } catch { /* no LTI form */ }
      if (form) {
        const target = new URL(form.action, result.url);
        if (target.origin !== BASE_URL || !target.pathname.startsWith('/learningx/lti/')) throw new AcquisitionError('EXTERNAL_TOOL_INVALID_URL', 'LTI form destination rejected', false);
        if (!visited.has(`POST:${target.href}`)) pending.unshift({ url: target.href, init: { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(result.url).origin, Referer: result.url },
          body: form.fields.toString() } });
      }
      const candidates = [
        ...[...result.text.matchAll(/<iframe\b[^>]*>/gi)].map(m => htmlAttributes(m[0]).src),
        ...[...result.text.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*(['"])([^'"]+)\1/g)].map(m => m[2]),
      ];
      const next: Array<{ url: string }> = [];
      for (const candidate of candidates) {
        if (!candidate || !isAllowedHttpDestination(candidate, result.url)) continue;
        const target = new URL(candidate, result.url);
        target.hash = '';
        if (visited.has(`GET:${target.href}`) || next.some(item => item.url === target.href)) continue;
        next.push({ url: target.href });
      }
      // Keep sibling candidates when one branch has no artifact or returns an error.
      // Signed form launches retain priority over passive targets.
      if (form) pending.splice(1, 0, ...next);
      else pending.unshift(...next);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'EXTERNAL_TOOL_SESSION_EXPIRED' || code === 'EXTERNAL_TOOL_INVALID_URL' || code === 'MATERIAL_NOT_OPEN') throw error;
      failures.push(error);
    }
  }
  if (pending.some(entry => !visited.has(`${entry.init?.method ?? 'GET'}:${entry.url}`))) {
    throw new AcquisitionError('EXTERNAL_TOOL_LIMIT_REACHED', 'ExternalTool page exploration limit reached', false);
  }
  if (failures.length) throw selectLaunchFailure(failures);
  throw new AcquisitionError('EXTERNAL_TOOL_NO_ARTIFACT', 'ExternalTool launch did not yield a downloadable file or OCS viewer URL', false);
}
