export const OCS_VIEWER_MARKER = 'ocs.cau.ac.kr/em/';

export interface HttpArtifactResponse {
  url: string;
  status: number;
  contentType?: string;
  contentDisposition?: string;
  filename?: string;
}

export type LaunchArtifactKind = 'ocs_viewer' | 'file' | 'video';

export interface LaunchArtifact {
  kind: LaunchArtifactKind;
  url: string;
  type?: string;
  filename?: string;
}

export interface ExternalToolLaunchRequest {
  type?: string | null;
  url?: string | null;
  requires_launch?: boolean;
  is_playwright_required?: boolean;
  is_playright_required?: boolean;
}

const SLIDE_EXTENSIONS = ['pdf', 'ppt', 'pptx'] as const;
const FILE_EXTENSIONS = [...SLIDE_EXTENSIONS, 'doc', 'docx', 'xls', 'xlsx', 'hwp', 'zip'] as const;

export function isOcsViewerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === 'https://ocs.cau.ac.kr' && !url.username && !url.password && /^\/em\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isCanvasModuleItemUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === 'https://eclass3.cau.ac.kr' && !url.username && !url.password
      && /^\/courses\/\d+\/modules\/items\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isExternalToolLaunchRequested(input: ExternalToolLaunchRequest): boolean {
  return input.type === 'ExternalTool'
    || input.requires_launch === true
    || input.is_playwright_required === true
    || input.is_playright_required === true;
}

function extensionFromFilename(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : undefined;
}

function extensionFromUrl(rawUrl: string): string | undefined {
  try {
    const pathname = new URL(rawUrl).pathname;
    return extensionFromFilename(pathname);
  } catch {
    return undefined;
  }
}

function typeFromContentType(contentType: string | undefined): string | undefined {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.includes('presentationml.presentation')) return 'pptx';
  if (ct.includes('ms-powerpoint')) return 'ppt';
  if (ct.includes('wordprocessingml.document')) return 'docx';
  if (ct.includes('msword')) return 'doc';
  if (ct.includes('spreadsheetml.sheet')) return 'xlsx';
  if (ct.includes('ms-excel')) return 'xls';
  return undefined;
}

function inferFileType(obs: HttpArtifactResponse): string | undefined {
  const fromName = extensionFromFilename(obs.filename);
  if (fromName && (FILE_EXTENSIONS as readonly string[]).includes(fromName)) return fromName;
  const fromContent = typeFromContentType(obs.contentType);
  if (fromContent) return fromContent;
  const fromUrl = extensionFromUrl(obs.url);
  if (fromUrl && (FILE_EXTENSIONS as readonly string[]).includes(fromUrl)) return fromUrl;
  return undefined;
}

function isAttachment(obs: HttpArtifactResponse): boolean {
  return (obs.contentDisposition ?? '').toLowerCase().includes('attachment');
}

function isLikelyHtml(obs: HttpArtifactResponse): boolean {
  const ct = (obs.contentType ?? '').toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml');
}

/** Classifies response headers without downloading the body. */
export function classifyHttpArtifact(obs: HttpArtifactResponse): LaunchArtifact | null {
  if (obs.status < 200 || obs.status >= 300) return null;
  if (/^(video\/|application\/(?:x-mpegurl|vnd\.apple\.mpegurl|dash\+xml))/i.test(obs.contentType ?? '')) {
    return { kind: 'video', url: obs.url, type: 'video' };
  }
  if (isOcsViewerUrl(obs.url) && (isLikelyHtml(obs) || !obs.contentType)) {
    return { kind: 'ocs_viewer', url: obs.url, type: 'ocs' };
  }
  if (isLikelyHtml(obs)) return null;
  const type = inferFileType(obs);
  return type || isAttachment(obs) ? { kind: 'file', url: obs.url, type, filename: obs.filename } : null;
}
