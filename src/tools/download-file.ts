import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileCache } from '../file-cache.js';
import { resolveDownloadFilename } from '../download-filename.js';
import { expandTilde, sanitizeFileName, materialStorageKey } from '../utils.js';

function getDownloadDir(): string {
  return process.env.ECLASS_DOWNLOAD_DIR ?? '~/Downloads/eclass';
}

const CREDENTIAL_ALLOWED_ORIGINS = new Set([
  'https://eclass3.cau.ac.kr',
  'https://ocs.cau.ac.kr',
]);

const MAX_DOWNLOAD_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function assertAllowedOrigin(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Download rejected: invalid URL`);
  }
  if (!CREDENTIAL_ALLOWED_ORIGINS.has(parsed.origin)) {
    throw new Error(`Download rejected: origin not in allowlist`);
  }
}

function isAllowedCredentialOrigin(url: string): boolean {
  try {
    return CREDENTIAL_ALLOWED_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

async function fetchDownloadResponse(url: string, token: string): Promise<Response> {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_DOWNLOAD_REDIRECTS; redirectCount += 1) {
    const sendAuth = isAllowedCredentialOrigin(currentUrl);
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: sendAuth ? { Authorization: `Bearer ${token}` } : undefined,
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error(`Download redirect missing location header: ${response.status}`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }

  throw new Error(`Download failed: too many redirects`);
}

export interface DownloadResult {
  file_id: string;
  display_name: string;
  local_path: string;
  size_bytes: number;
  skipped: boolean;   // true if already downloaded
}

export interface CacheValidationHit {
  local_path: string;
  size_bytes: number;
}

interface CacheValidationView {
  get(fileId: string): { local_path: string; size_bytes: number; course_id?: number; source?: string | null } | null | undefined;
  findByName(courseId: number, displayName: string): { local_path: string; size_bytes: number } | null | undefined;
  record(entry: import('../file-cache.js').DownloadRecord): void;
}

/**
 * Validates a download by source-native ID and course. Titles and local byte
 * sizes cannot establish that two different source IDs identify the same file.
 * Shared by downloadFile (direct path) and downloadOne (unified executor).
 */
export async function validateCachedDownload(
  cache: CacheValidationView,
  item: { file_id: string; course_id: number; display_name: string; source?: string | null },
): Promise<CacheValidationHit | null> {
  const existing = cache.get(item.file_id);
  if (existing && existing.course_id === item.course_id && (!item.source || !existing.source || item.source === existing.source)) {
    try {
      await fs.access(existing.local_path);
      return { local_path: existing.local_path, size_bytes: existing.size_bytes };
    } catch {
      // File was deleted from disk — re-download
    }
  }

  return null;
}

/**
 * Fetches a direct/canvas file URL to disk. No cache logic — callers handle
 * caching. Returns the saved path and byte size.
 */
export async function downloadFileToDisk(
  courseId: number,
  url: string,
  displayName: string,
  token: string,
  fileId?: string,
): Promise<{ local_path: string; size_bytes: number }> {
  // Validate download URL origin before sending bearer token
  assertAllowedOrigin(url);
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname === 'ocs.cau.ac.kr') {
    throw new Error('OCS documents require the HTTP metadata download path with a viewer URL');
  }

  // Sanitize filename to prevent path traversal
  const safeName = sanitizeFileName(displayName);
  if (!safeName) {
    throw new Error(`Invalid displayName: ${JSON.stringify(displayName)}`);
  }

  const dir = path.join(expandTilde(getDownloadDir()), String(courseId), ...(fileId ? [materialStorageKey(fileId)] : []));
  await fs.mkdir(dir, { recursive: true });

  const response = await fetchDownloadResponse(url, token);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  if (/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Download rejected: HTML response instead of file');
  }

  const resolvedName = resolveDownloadFilename(safeName, {
    contentDisposition: response.headers.get('content-disposition'),
    contentType: response.headers.get('content-type'),
  });
  const localPath = path.join(dir, resolvedName);

  const buffer = await response.arrayBuffer();
  const bytes = Buffer.from(buffer);
  if (/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(bytes.subarray(0, 512).toString('utf8').replace(/^\uFEFF/, ''))) {
    throw new Error('Download rejected: HTML body instead of file');
  }
  if (bytes.length === 0) throw new Error('Download rejected: empty file');
  await fs.writeFile(localPath, bytes);

  return { local_path: localPath, size_bytes: buffer.byteLength };
}

export async function downloadFile(
  fileId: string,
  courseId: number,
  url: string,
  displayName: string,
  token: string,
  cache: FileCache,
  source?: string | null,
): Promise<DownloadResult> {
  const cached = await validateCachedDownload(cache, {
    file_id: fileId,
    course_id: courseId,
    display_name: displayName,
    source,
  });
  if (cached) {
    return {
      file_id: fileId,
      display_name: displayName,
      local_path: cached.local_path,
      size_bytes: cached.size_bytes,
      skipped: true,
    };
  }

  const { local_path: localPath, size_bytes: sizeBytes } = await downloadFileToDisk(
    courseId,
    url,
    displayName,
    token,
    fileId,
  );

  cache.record({
    file_id: fileId,
    course_id: courseId,
    display_name: displayName,
    local_path: localPath,
    downloaded_at: new Date().toISOString(),
    size_bytes: sizeBytes,
    ...(source !== undefined ? { source } : {}),
  });

  return {
    file_id: fileId,
    display_name: displayName,
    local_path: localPath,
    size_bytes: sizeBytes,
    skipped: false,
  };
}
