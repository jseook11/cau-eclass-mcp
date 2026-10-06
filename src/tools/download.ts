import * as fs from 'node:fs/promises';
import { BrowserSession } from '../browser-session.js';
import { FileCache } from '../file-cache.js';
import type { ResolvedLocator } from '../file-cache.js';
import {
  resolveDownloadStrategy,
  isResolvedHttpStrategy,
  type DownloadStrategy,
} from '../download-strategy.js';
import { downloadFileToDisk, validateCachedDownload } from './download-file.js';
import { acquisitionError, acquisitionStatus, classifyMaterial, AcquisitionError, materialFingerprint, type MaterialAcquisition, type AcquisitionStatus } from '../material-acquisition.js';
import { resolveMaterial } from '../resolve-material.js';
import { sanitizeFileName } from '../utils.js';
import {
  isCanvasModuleItemUrl,
  isExternalToolLaunchRequested,
  isOcsViewerUrl,
} from '../external-tool-launch.js';

export interface DownloadItem extends Partial<MaterialAcquisition> {
  file_id: string;
  course_id: number;
  url: string | null;
  display_name: string;
  type?: string | null;
  source?: string | null;
  requires_launch?: boolean;
  is_playwright_required?: boolean;
  is_playright_required?: boolean;
  external_url?: string | null;
  module_name?: string;
  locked_for_user?: boolean;
  unlock_at?: string | null;
}

export interface DownloadOutcome {
  file_id: string;
  display_name: string;
  status: 'downloaded' | 'skipped' | 'failed' | AcquisitionStatus;
  strategy: DownloadStrategy;
  local_path?: string;
  size_bytes?: number;
  error_code?: string;
  message?: string;
  retryable?: boolean;
  next_action?: string;
  failure_kind?: 'failed_retryable' | 'failed_terminal';
}

export interface DownloadDeps {
  session: BrowserSession;
  fileCache: FileCache;
  token: string;
}

function getDownloadDir(): string {
  return process.env.ECLASS_DOWNLOAD_DIR ?? '~/Downloads/eclass';
}

function sanitizeName(displayName: string): string | null {
  return sanitizeFileName(displayName);
}

function failed(
  item: DownloadItem,
  strategy: DownloadStrategy,
  errorCode: string,
  message: string,
  retryable: boolean,
): DownloadOutcome {
  return { file_id: item.file_id, display_name: item.display_name, status: 'failed', strategy, error_code: errorCode, message, retryable,
    failure_kind: retryable ? 'failed_retryable' : 'failed_terminal', next_action: retryable ? 'retry_with_backoff' : 'none' };
}

function excluded(item: DownloadItem, strategy: DownloadStrategy, status: AcquisitionStatus, reason?: string, errorCode?: string): DownloadOutcome {
  return { file_id: item.file_id, display_name: item.display_name, strategy, status, retryable: false,
    ...(reason ? { message: reason } : {}), ...(errorCode ? { error_code: errorCode } : {}),
    next_action: status === 'needs_resolution' ? 'resolve_material' : status === 'not_open' ? 'wait_until_open' : 'none' };
}

function rememberLocator(cache: FileCache, locator: ResolvedLocator): void {
  if (typeof cache.setResolvedLocator === 'function') {
    cache.setResolvedLocator(locator);
  }
}

async function resolveExternalToolLocator(deps: DownloadDeps, item: DownloadItem): Promise<ResolvedLocator> {
  const cached = typeof deps.fileCache.getResolvedLocator === 'function'
    ? deps.fileCache.getResolvedLocator(item.file_id)
    : undefined;
  if (cached?.resolved_url && cached.course_id === item.course_id && cached.fingerprint === materialFingerprint(item)) return cached;

  const currentUrl = item.url;
  const knownDocument = classifyMaterial(item).asset_kind === 'document'
    || (item.asset_kind === 'document' && item.downloadable === true && item.acquisition_policy === 'download');
  if (knownDocument && currentUrl && isOcsViewerUrl(currentUrl)) {
    const locator: ResolvedLocator = {
      file_id: item.file_id,
      course_id: item.course_id,
      resolved_url: currentUrl,
      resolved_type: item.type === 'ExternalTool' ? 'pdf' : item.type ?? 'ocs',
      display_name: item.display_name,
      resolved_at: new Date().toISOString(),
    };
    rememberLocator(deps.fileCache, locator);
    return locator;
  }

  if (knownDocument && currentUrl && !isCanvasModuleItemUrl(currentUrl) && !/\/external_tools\//.test(currentUrl)) {
    const locator: ResolvedLocator = {
      file_id: item.file_id,
      course_id: item.course_id,
      resolved_url: currentUrl,
      resolved_type: item.type ?? null,
      display_name: item.display_name,
      resolved_at: new Date().toISOString(),
    };
    rememberLocator(deps.fileCache, locator);
    return locator;
  }

  if (!currentUrl) {
    throw new Error('ExternalTool launch requires a module item URL');
  }

  const resolution = await resolveMaterial(deps.session, deps.fileCache, item.course_id, item);
  if (resolution.error_code && resolution.error_code !== 'EXTERNAL_TOOL_NO_ARTIFACT') {
    throw new AcquisitionError(resolution.error_code, resolution.reason ?? resolution.resolution_reason, resolution.retryable);
  }
  if (resolution.retryable) throw new AcquisitionError(resolution.error_code ?? 'DOWNLOAD_FAILED', resolution.reason ?? resolution.resolution_reason, true);
  const status = acquisitionStatus(resolution);
  if (status) throw new AcquisitionError(status === 'excluded_video' ? 'EXTERNAL_TOOL_VIDEO' : 'EXTERNAL_TOOL_NO_ARTIFACT', resolution.reason ?? resolution.resolution_reason, false);
  const locator: ResolvedLocator = {
    file_id: item.file_id,
    course_id: item.course_id,
    resolved_url: resolution.resolved_url!,
    resolved_type: resolution.resolved_type ?? null,
    display_name: resolution.resolved_name ?? item.display_name,
    resolved_at: new Date().toISOString(),
    fingerprint: materialFingerprint(item),
  };
  rememberLocator(deps.fileCache, locator);
  return locator;
}

async function downloadResolved(
  deps: DownloadDeps,
  item: DownloadItem,
  safeName: string,
  displayName: string,
  resolvedUrl: string,
  resolvedType?: string | null,
): Promise<{ localPath: string; sizeBytes: number }> {
  const transport = resolveDownloadStrategy(
    resolvedUrl,
    resolvedType,
    false,
  );
  if (transport === 'missing_locator') throw new AcquisitionError('MATERIAL_MISSING_LOCATOR', 'Material has no download locator', false);
  if (transport === 'unsupported_streaming_media') {
    throw new Error(
      `파일 다운로드 도구는 동영상/스트리밍 자료를 처리하지 않습니다. OCS MP4 동영상은 eclass_download_video를 사용하세요: type=${resolvedType ?? ''}`,
    );
  }
  if (isResolvedHttpStrategy(transport) && transport !== 'external_tool_launch') {
    const localPath = await deps.session.downloadCourseresourceFile(
      item.course_id,
      item.file_id,
      safeName,
      getDownloadDir(),
      transport === 'ocs_http' ? resolvedUrl : undefined,
    );
    const stat = await fs.stat(localPath);
    return { localPath, sizeBytes: stat.size };
  }
  const result = await downloadFileToDisk(item.course_id, resolvedUrl, displayName, deps.token, item.file_id);
  return { localPath: result.local_path, sizeBytes: result.size_bytes };
}

/**
 * Unified single-material download. Validates the cache, resolves the transport
 * strategy, dispatches to the corresponding HTTP path, records the
 * result with its source, and returns a structured outcome. Never throws for
 * expected failures or exclusions. Only actual failures use status 'failed'.
 */
export async function downloadOne(deps: DownloadDeps, item: DownloadItem): Promise<DownloadOutcome> {
  const strategy = resolveDownloadStrategy(
    item.url,
    item.type,
    isExternalToolLaunchRequested(item),
  );

  const inferred = classifyMaterial(item);
  const acquisition: MaterialAcquisition = {
    asset_kind: item.asset_kind ?? inferred.asset_kind,
    downloadable: item.downloadable ?? inferred.downloadable,
    acquisition_policy: item.acquisition_policy ?? inferred.acquisition_policy,
    resolution_reason: item.resolution_reason ?? inferred.resolution_reason,
  };
  // Current lock/video evidence always beats stale caller metadata or a cache hit.
  const inferredStatus = acquisitionStatus(inferred);
  if (inferred.acquisition_policy === 'not_open' || inferred.acquisition_policy === 'exclude') {
    return excluded(item, strategy, inferredStatus!, inferred.resolution_reason);
  }
  const status = acquisitionStatus(acquisition);
  if (status && (item.acquisition_policy !== undefined || item.downloadable === false || item.asset_kind !== undefined)) {
    return excluded(item, strategy, status, acquisition.resolution_reason);
  }

  if (strategy === 'unsupported_streaming_media') {
    return excluded(item, strategy, 'excluded_video', 'streaming_media', 'DOWNLOAD_UNSUPPORTED_MEDIA');
  }

  // Unclassified wrappers must resolve before any download cache can satisfy them.
  const cached = item.type === 'ExternalTool' && inferred.asset_kind === 'unresolved' && acquisition.asset_kind !== 'document'
    ? null : await validateCachedDownload(deps.fileCache, item);
  if (cached) {
    return {
      file_id: item.file_id,
      display_name: item.display_name,
      status: 'skipped',
      strategy: 'already_cached',
      local_path: cached.local_path,
      size_bytes: cached.size_bytes,
    };
  }

  const safeName = sanitizeName(item.display_name);
  if (!safeName) {
    return failed(item, strategy, 'DOWNLOAD_INVALID_NAME', `유효하지 않은 파일명입니다: ${JSON.stringify(item.display_name)}`, false);
  }

  try {
    let localPath: string;
    let sizeBytes: number;

    if (strategy === 'external_tool_launch') {
      if (!item.url) {
        return excluded(item, strategy, 'needs_resolution', 'external_tool_url_missing', 'EXTERNAL_TOOL_URL_MISSING');
      } else {
        const locator = await resolveExternalToolLocator(deps, item);
        const resolvedDisplayName = locator.display_name?.trim() || item.display_name;
        const resolvedSafeName = sanitizeName(resolvedDisplayName) ?? safeName;
        const downloaded = await downloadResolved(
          deps,
          item,
          resolvedSafeName,
          resolvedDisplayName,
          locator.resolved_url,
          locator.resolved_type,
        );
        localPath = downloaded.localPath;
        sizeBytes = downloaded.sizeBytes;
      }
    } else if (strategy === 'missing_locator') {
      throw new AcquisitionError('MATERIAL_MISSING_LOCATOR', 'Material has no download locator', false);
    } else if (isResolvedHttpStrategy(strategy)) {
      localPath = await deps.session.downloadCourseresourceFile(
        item.course_id,
        item.file_id,
        safeName,
        getDownloadDir(),
        strategy === 'ocs_http' ? item.url! : undefined,
      );
      const stat = await fs.stat(localPath);
      sizeBytes = stat.size;
    } else {
      const result = await downloadFileToDisk(item.course_id, item.url!, item.display_name, deps.token, item.file_id);
      localPath = result.local_path;
      sizeBytes = result.size_bytes;
    }

    deps.fileCache.record({
      file_id: item.file_id,
      course_id: item.course_id,
      display_name: item.display_name,
      local_path: localPath,
      downloaded_at: new Date().toISOString(),
      size_bytes: sizeBytes,
      source: item.source ?? null,
    });

    return {
      file_id: item.file_id,
      display_name: item.display_name,
      status: 'downloaded',
      strategy,
      local_path: localPath,
      size_bytes: sizeBytes,
    };
  } catch (err) {
    const error = acquisitionError(err);
    if (error.code === 'MATERIAL_NOT_OPEN') return excluded(item, strategy, 'not_open', error.reason, error.code);
    if (error.code === 'EXTERNAL_TOOL_NO_ARTIFACT') return excluded(item, strategy, 'needs_resolution', error.reason, error.code);
    if (error.code === 'EXTERNAL_TOOL_VIDEO') return excluded(item, strategy, 'excluded_video', error.reason, error.code);
    return failed(item, strategy, error.code, error.reason, error.retryable);
  }
}
