import { isStreamingMediaType } from './media-types.js';
import { createHash } from 'node:crypto';
import { sanitizeDebug, isRetryableReason } from './errors.js';
import type { LaunchArtifact } from './external-tool-launch.js';

export type AssetKind = 'document' | 'video' | 'interactive' | 'unresolved';
export type AcquisitionPolicy = 'download' | 'exclude' | 'needs_resolution' | 'not_open';
export type AcquisitionStatus = 'excluded_video' | 'excluded_interactive' | 'not_downloadable' | 'needs_resolution' | 'not_open';

export interface MaterialAcquisition {
  asset_kind: AssetKind;
  downloadable: boolean;
  acquisition_policy: AcquisitionPolicy;
  resolution_reason: string;
}

export interface AcquisitionInput {
  id?: string;
  file_id?: string;
  title?: string;
  display_name?: string;
  type?: string | null;
  url?: string | null;
  external_url?: string | null;
  module_name?: string;
  locked_for_user?: boolean;
  unlock_at?: string | null;
}

const documentTypes = new Set(['file', 'pdf', 'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx', 'hwp', 'hwpx', 'zip', 'txt', 'image', 'png', 'jpg', 'jpeg', 'gif']);

export function classifyMaterial(input: AcquisitionInput, now = Date.now()): MaterialAcquisition {
  const type = (input.type ?? '').trim().toLowerCase().split(';')[0];
  let kind: AssetKind = 'unresolved';
  let reason = 'semantic_type_unknown';
  if (isStreamingMediaType(type)) {
    kind = 'video'; reason = 'explicit_video_type';
  } else if (documentTypes.has(type) || /^(application\/(pdf|zip|octet-stream|msword|vnd\.(ms-|openxmlformats|hancom))|image\/|text\/plain)/.test(type)) {
    kind = 'document'; reason = 'explicit_file_type';
  } else if (['page', 'assignment', 'quiz', 'discussion'].includes(type)) {
    kind = 'interactive'; reason = 'canvas_non_file_item';
  } else if (type === 'subheader') {
    reason = 'canvas_subheader';
  }
  // A wrapper title, module name or generic OCS viewer is never file evidence.
  if (kind === 'unresolved' && input.external_url) {
    try {
      const target = new URL(input.external_url);
      const ext = target.pathname.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
      if (ext && isStreamingMediaType(ext)) { kind = 'video'; reason = 'external_video_url'; }
      else if (ext && documentTypes.has(ext)) { kind = 'document'; reason = 'external_file_url'; }
      else if (target.hostname === 'eclass3.cau.ac.kr' && /\/files\/\d+(?:\/download)?\/?$/.test(target.pathname)) {
        kind = 'document'; reason = 'canvas_file_target';
      }
    } catch { /* Invalid locators remain unresolved. */ }
  }
  const locked = input.locked_for_user === true || (input.unlock_at != null && Date.parse(input.unlock_at) > now);
  return {
    asset_kind: kind,
    downloadable: !locked && kind === 'document',
    acquisition_policy: locked ? 'not_open' : kind === 'document' ? 'download'
      : kind === 'video' || kind === 'interactive' || reason === 'canvas_subheader' ? 'exclude' : 'needs_resolution',
    resolution_reason: locked ? 'module_locked' : reason,
  };
}

export function classifyLaunchArtifact(artifact: LaunchArtifact): MaterialAcquisition {
  if (artifact.kind === 'video') return { asset_kind: 'video', downloadable: false, acquisition_policy: 'exclude', resolution_reason: 'launch_video' };
  if (artifact.kind === 'file') return { asset_kind: 'document', downloadable: true, acquisition_policy: 'download', resolution_reason: 'launch_file' };
  const content = classifyMaterial({ type: artifact.type });
  if (content.asset_kind === 'document') return { ...content, resolution_reason: 'launch_ocs_document' };
  // /em/<id> is shared by slide viewers and video players.
  return { asset_kind: 'unresolved', downloadable: false, acquisition_policy: 'needs_resolution', resolution_reason: 'ocs_viewer_type_unknown' };
}

export function acquisitionStatus(acquisition: MaterialAcquisition): AcquisitionStatus | undefined {
  if (acquisition.acquisition_policy === 'download' && acquisition.downloadable) return undefined;
  if (acquisition.acquisition_policy === 'not_open') return 'not_open';
  if (acquisition.asset_kind === 'video') return 'excluded_video';
  if (acquisition.asset_kind === 'interactive') return 'excluded_interactive';
  return acquisition.acquisition_policy === 'needs_resolution' ? 'needs_resolution' : 'not_downloadable';
}

export function materialFingerprint(input: AcquisitionInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.id ?? input.file_id, input.title ?? input.display_name, input.type ?? null,
    input.url ?? null, input.external_url ?? null, input.module_name ?? null,
    input.locked_for_user ?? false, input.unlock_at ?? null,
  ])).digest('hex');
}

export class AcquisitionError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable: boolean) {
    super(message); this.name = 'AcquisitionError';
  }
}

export function acquisitionError(err: unknown): { code: string; reason: string; retryable: boolean } {
  const raw = err instanceof Error ? err.message : String(err);
  const reason = sanitizeDebug(raw) || 'Unknown error';
  if (err instanceof AcquisitionError) return { code: err.code, reason, retryable: err.retryable };
  if (raw.includes('ExternalTool launch did not yield a downloadable file or OCS viewer URL')) {
    return { code: 'EXTERNAL_TOOL_NO_ARTIFACT', reason, retryable: false };
  }
  return { code: 'DOWNLOAD_FAILED', reason, retryable: /\b401\b/.test(raw) || isRetryableReason(raw) };
}
