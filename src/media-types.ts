/** Types excluded from document acquisition, including LearningX video wrappers. */
export const STREAMING_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'video', 'movie', 'everlec', 'mp4', 'm3u8', 'hls', 'dash', 'mpd', 'webm',
  'mov', 'm4v', 'avi', 'wmv', 'media', 'stream', 'streaming', 'vod',
  'audio', 'mp3', 'wav',
]);

export function isStreamingMediaType(type: string | null | undefined): boolean {
  const normalized = (type ?? '').split(';')[0].trim().toLowerCase();
  return STREAMING_MEDIA_TYPES.has(normalized)
    || /^(video|audio)\//.test(normalized) || /mpegurl|dash\+xml/.test(normalized);
}
