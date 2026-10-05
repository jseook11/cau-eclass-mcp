import * as path from 'node:path';

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/msword': '.doc',
  'application/vnd.ms-excel': '.xls',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'text/plain': '.txt',
  'text/html': '.html',
};

function fileExtension(name: string): string | undefined {
  const ext = path.extname(name);
  // Preserve unknown suffixes such as .py and .7z, but not lecture numbering.
  return /^\.(?=[a-z0-9]*[a-z])[a-z0-9]+$/i.test(ext) ? ext : undefined;
}

export function resolveDownloadFilename(
  safeName: string,
  headers: { contentDisposition?: string | null; contentType?: string | null },
): string {
  // Dots in lecture titles (such as algorithm_02.2_divide) are not extensions.
  if (fileExtension(safeName)) return safeName;

  if (headers.contentDisposition) {
    const match = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i.exec(headers.contentDisposition);
    if (match) {
      const ext = fileExtension(decodeURIComponent(match[1].trim()));
      if (ext) return safeName + ext;
    }
  }

  const contentType = (headers.contentType ?? '').split(';')[0].trim().toLowerCase();
  const ext = MIME_TO_EXT[contentType];
  return ext ? safeName + ext : safeName;
}
