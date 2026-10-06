// Live HTTP verification: safe counts only; downloaded samples are removed in finally.
// pnpm exec tsx scripts/probe-http-materials.ts <course_id> [course_id ...]
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserSession } from '../src/browser-session.js';
import { resolveDoctorCredentials } from '../src/doctor.js';
import { getEclassPassword } from '../src/secrets.js';
import { downloadOne } from '../src/tools/download.js';
import { FileCache } from '../src/file-cache.js';
import { classifyLaunchArtifact } from '../src/material-acquisition.js';
import { isStreamingMediaType } from '../src/browser-session.js';

const ids = process.argv.slice(2).map(Number);
if (!ids.length || ids.length > 10 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Usage: probe-http-materials.ts <course_id> [course_id ...] (max 10)');
const credentials = await resolveDoctorCredentials();
if (!credentials.username) throw new Error('Configured username missing');
const username = credentials.username;
const session = new BrowserSession(username, () => getEclassPassword(username, credentials.envPassword, undefined, credentials.plaintextOverride));
// Any accidental submission/browser path makes this probe fail.
session.ensurePlaywrightReady = async () => { throw new Error('Unexpected browser dependency'); };
const client = await session.getClient();
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eclass-http-probe-'));
const cache = new FileCache(path.join(directory, 'probe.db'));
const priorDirectory = process.env.ECLASS_DOWNLOAD_DIR;
process.env.ECLASS_DOWNLOAD_DIR = directory;
try {
  for (const courseId of ids) {
    const modulebuilder = await session.fetchModulebuilder(courseId);
    const courseresources = await session.fetchCourseresources(courseId);
    const sample = [...modulebuilder, ...courseresources].find(item => item.type === 'pdf' && item.url?.startsWith('https://ocs.cau.ac.kr/em/'));
    let document: { bytes: number; pdf_signature: boolean; extension: boolean } | null = null;
    if (sample?.url) {
      const saved = await session.downloadCourseresourceFile(courseId, sample.id, sample.title, directory, sample.url);
      const bytes = await fs.readFile(saved);
      document = { bytes: bytes.length, pdf_signature: bytes.subarray(0,5).toString() === '%PDF-', extension: saved.endsWith('.pdf') };
      if (!document.pdf_signature || !document.extension) throw new Error('OCS PDF validation failed');
    }
    const modules = await client.fetchOne<Array<{ items?: Array<{ type?: string; html_url?: string }> }>>(`/api/v1/courses/${courseId}/modules?include[]=items`);
    const external = modules.flatMap(m => m.items ?? []).filter(i => i.type === 'ExternalTool' && i.html_url);
    const launches = [];
    for (const item of external.slice(0,2)) {
      let artifact;
      try { artifact = await session.resolveExternalToolLaunch(courseId, item.html_url!); }
      catch (error) {
        if ((error as { code?: string }).code === 'MATERIAL_NOT_OPEN') { launches.push({ kind: 'not_open' }); continue; }
        throw error;
      }
      let file: { bytes: number; zip_signature: boolean; pdf_signature: boolean } | null = null;
      if (classifyLaunchArtifact(artifact).downloadable && !isStreamingMediaType(artifact.type)) {
        const result = await downloadOne({session, fileCache: cache, token: client.getToken()}, {
          course_id: courseId, file_id: `probe-${courseId}-${launches.length}`, display_name: artifact.filename ?? 'attachment',
          url: item.html_url!, type: 'ExternalTool',
        });
        if (result.status !== 'downloaded' || !result.local_path) throw new Error(`HTTP acquisition failed: ${result.error_code ?? result.status}`);
        const bytes = await fs.readFile(result.local_path);
        file = { bytes: bytes.length, zip_signature: bytes.subarray(0,2).toString() === 'PK', pdf_signature: bytes.subarray(0,5).toString() === '%PDF-' };
        if (artifact.type === 'pptx' && !file.zip_signature || artifact.type === 'pdf' && !file.pdf_signature) throw new Error('ExternalTool file validation failed');
      }
      launches.push({ kind: artifact.kind, type: artifact.type, file });
    }
    console.log(JSON.stringify({ course_id: courseId, modulebuilder: modulebuilder.length, courseresource: courseresources.length, document, launches, transport: 'http' }));
  }
} finally {
  if (priorDirectory === undefined) delete process.env.ECLASS_DOWNLOAD_DIR;
  else process.env.ECLASS_DOWNLOAD_DIR = priorDirectory;
  cache.getDb().close();
  await fs.rm(directory, { recursive: true, force: true });
}
