import type { FileCache, MaterialResolution } from './file-cache.js';
import type { BrowserSession } from './browser-session.js';
import { acquisitionError, classifyLaunchArtifact, materialFingerprint, type AcquisitionInput } from './material-acquisition.js';
import { parseLearningxBoardLocation } from './http-materials.js';

/** Resolve the wrapper's purpose without writing a downloaded artifact. */
export async function resolveMaterial(
  session: BrowserSession, cache: FileCache | undefined, courseId: number, input: AcquisitionInput,
): Promise<MaterialResolution> {
  const fileId = input.id ?? input.file_id!;
  const fingerprint = materialFingerprint(input);
  const previous = cache?.getMaterialResolution?.(courseId, fileId, fingerprint);
  const board = input.external_url ? parseLearningxBoardLocation(input.external_url) : null;
  if (!board && previous && !previous.retryable && previous.acquisition_policy !== 'not_open') return previous;
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
      asset_kind: 'unresolved', downloadable: false, acquisition_policy: error.code === 'MATERIAL_NOT_OPEN' ? 'not_open' : 'needs_resolution',
      resolution_reason: error.code, course_id: courseId, file_id: fileId, fingerprint,
      error_code: error.code, reason: error.reason, retryable: error.retryable,
      observed_at: new Date().toISOString(),
    };
  }
  cache?.setMaterialResolution?.(result);
  return result;
}
