import type { FileCache, MaterialResolution } from './file-cache.js';
import type { BrowserSession } from './browser-session.js';
import { acquisitionError, classifyLaunchArtifact, materialFingerprint, type AcquisitionInput } from './material-acquisition.js';

/** Resolve the wrapper's purpose without writing a downloaded artifact. */
export async function resolveMaterial(
  session: BrowserSession, cache: FileCache | undefined, courseId: number, input: AcquisitionInput,
): Promise<MaterialResolution> {
  const fileId = input.id ?? input.file_id!;
  const fingerprint = materialFingerprint(input);
  const previous = cache?.getMaterialResolution?.(courseId, fileId, fingerprint);
  if (previous && !previous.retryable) return previous;
  let result: MaterialResolution;
  try {
    const artifact = await session.resolveExternalToolLaunch(courseId, input.url!);
    result = {
      ...classifyLaunchArtifact(artifact), course_id: courseId, file_id: fileId, fingerprint,
      retryable: false, observed_at: new Date().toISOString(),
      resolved_url: artifact.url, resolved_type: artifact.type, resolved_name: artifact.filename,
    };
  } catch (err) {
    const error = acquisitionError(err);
    result = {
      asset_kind: 'unresolved', downloadable: false, acquisition_policy: 'needs_resolution',
      resolution_reason: error.code, course_id: courseId, file_id: fileId, fingerprint,
      error_code: error.code, reason: error.reason, retryable: error.retryable,
      observed_at: new Date().toISOString(),
    };
  }
  cache?.setMaterialResolution?.(result);
  return result;
}
