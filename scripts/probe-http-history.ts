import { readFile } from 'node:fs/promises';
import { BrowserSession, isStreamingMediaType } from '../src/browser-session.js';
import { resolveDoctorCredentials } from '../src/doctor.js';
import { getEclassPassword } from '../src/secrets.js';

import { CanvasClient } from '../src/canvas-client.js';
import { getMaterials } from '../src/tools/get-materials.js';
import { resolveHttpExternalTool } from '../src/http-materials.js';

// pnpm exec tsx scripts/probe-http-history.ts > /tmp/eclass-http-history.jsonl
// Full accessible enrollment history, including completed enrollments and courses.
// No video bodies, attendance writes, or persistent material cache are used.
const credentials = await resolveDoctorCredentials();
if (!credentials.username) throw new Error('Configured username missing');
const username = credentials.username;
const session = new BrowserSession(username, () => getEclassPassword(username, credentials.envPassword, undefined, credentials.plaintextOverride));
session.ensurePlaywrightReady = async () => { throw new Error('Unexpected browser dependency'); };
const client = await session.getClient();
let courses = await client.fetchAll<{ id: string | number; term?: { name?: string }; enrollments?: Array<{ type?: string }>; workflow_state?: string }>(
  '/api/v1/courses?include[]=term&include[]=enrollments&state[]=available&state[]=completed', { per_page: '100', enrollment_type: 'student' });
const retry = new Map<number, Set<string>>();
if (process.argv.length > 2) {
  if (process.argv[2] !== '--retry-failures' || !process.argv[3] || process.argv.length !== 4) throw new Error('Usage: probe-http-history.ts [--retry-failures <jsonl>]');
  for (const line of (await readFile(process.argv[3], 'utf8')).split('\n').filter(Boolean)) {
    const row = JSON.parse(line) as { event?: string; course_id?: number; failures?: Array<{ id: string }> };
    if (row.event === 'course' && row.course_id && row.failures?.length) retry.set(row.course_id, new Set(row.failures.map(f => f.id)));
  }
  courses = courses.filter(course => retry.has(Number(course.id)));
}
console.log(JSON.stringify({ event: 'history', courses: courses.length, retry_only: retry.size > 0 }));
const totals = { courses: courses.length, interactive: 0, materials: 0, locators: 0, resolved: 0, videos: 0, not_open: 0, failed: 0, source_errors: 0 };
for (const course of courses) {
  const id = Number(course.id);
  const result = await getMaterials(client, session, id, ['modules', 'files', 'courseresource', 'external', 'modulebuilder', 'announcements']);
  console.log(JSON.stringify({ event: 'course_begin', course_id: id }));
  const counts = { interactive: 0, materials: result.materials.length, locators: 0, resolved: 0, videos: 0, not_open: 0, failed: 0 };
  const failures: Array<{ id: string; code: string; type: string; source: string }> = [];
  const checked = new Set<string>();
  // Keep one authenticated cookie session per course; do not reacquire it per locator.
  const readClient = new CanvasClient('https://eclass3.cau.ac.kr', client.getToken());
  await session.withHttpSession(async http => {
    for (const material of result.materials) {
      if (retry.size && !retry.get(id)?.has(material.id)) continue;
      if (material.acquisition_policy === 'not_open' || material.locked_for_user) { counts.not_open++; continue; }
      if (isStreamingMediaType(material.type) || material.asset_kind === 'video') { counts.videos++; continue; }
      if (material.asset_kind === 'interactive') { counts.interactive++; continue; }
      if (!material.url || checked.has(material.url)) continue;
      checked.add(material.url);
      counts.locators++;
      try {
        if (material.type === 'ExternalTool' || material.url!.startsWith('https://ocs.cau.ac.kr/em/')) {
          const artifact = await resolveHttpExternalTool(http, readClient, id, material.url!);
          if (artifact.kind === 'video') { counts.videos++; continue; }
          counts.resolved++;
        } else {
          // Use GET headers, then cancel the body: signed storage URLs can reject HEAD. Canvas downloads may redirect to storage.
          const response = await fetch(material.url!, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30_000),
            headers: new URL(material.url!).origin === 'https://eclass3.cau.ac.kr' ? { Authorization: `Bearer ${client.getToken()}` } : {} });
          await response.body?.cancel();
          if (!response.ok) throw Object.assign(new Error('Direct response rejected'), { code: `DIRECT_HTTP_${response.status}` });
          if ((response.headers.get('content-type') ?? '').includes('text/html')) throw Object.assign(new Error('Expected file response'), { code: 'DIRECT_NON_DOCUMENT_RESPONSE' });
          counts.resolved++;
        }
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'HTTP_PROBE_FAILED';
        if (code === 'MATERIAL_NOT_OPEN') counts.not_open++;
        else { counts.failed++; failures.push({ id: material.id, code, type: material.type, source: material.source }); }
      }
    }
  });
  totals.interactive += counts.interactive;
  totals.materials += counts.materials; totals.locators += counts.locators; totals.resolved += counts.resolved;
  totals.videos += counts.videos; totals.not_open += counts.not_open; totals.failed += counts.failed;
  totals.source_errors += result.errors.length;
  console.log(JSON.stringify({ event: 'course', course_id: id, term: course.term?.name, state: course.workflow_state, ...counts,
    source_errors: result.errors.map(e => ({ source: e.source, reason: e.reason })), failures }));
}
console.log(JSON.stringify({ event: 'summary', ...totals, browser_launched: false, video_downloaded: false }));
