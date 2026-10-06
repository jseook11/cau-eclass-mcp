import { isStreamingMediaType } from './media-types.js';

// How a material should be fetched. `already_cached` is a runtime result state
// (decided by cache validation), not chosen by resolveDownloadStrategy.
export type DownloadStrategy =
  | 'already_cached'
  | 'canvas_file'
  | 'direct_url'
  | 'ocs_http'
  | 'missing_locator'
  | 'external_tool_launch'
  | 'unsupported_streaming_media';

export const OCS_VIEWER_MARKER = 'ocs.cau.ac.kr/em/';

/**
 * Decides the transport strategy from a material's url, type, and launch flag.
 * Type/flag beat URL host: ExternalTool wrapper pages on eclass3 are not
 * Canvas files.
 */
export function resolveDownloadStrategy(
  url: string | null | undefined,
  type?: string | null,
  requiresLaunch?: boolean,
): Exclude<DownloadStrategy, 'already_cached'> {
  if (isStreamingMediaType(type)) return 'unsupported_streaming_media';
  if (requiresLaunch || type === 'ExternalTool') return 'external_tool_launch';
  if (!url) return 'missing_locator';
  if (url.includes(OCS_VIEWER_MARKER)) return 'ocs_http';
  try {
    if (new URL(url).hostname === 'eclass3.cau.ac.kr') return 'canvas_file';
  } catch {
    // fall through — treat unparseable as direct_url so the origin allowlist rejects it later
  }
  return 'direct_url';
}

export function isResolvedHttpStrategy(strategy: DownloadStrategy): boolean {
  return strategy === 'ocs_http' || strategy === 'external_tool_launch';
}

export function isDirectStrategy(strategy: DownloadStrategy): boolean {
  return strategy === 'canvas_file' || strategy === 'direct_url';
}
