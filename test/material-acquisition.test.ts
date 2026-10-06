import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileCache } from '../src/file-cache.js';
import { getMaterials } from '../src/tools/get-materials.js';
import { downloadOne, type DownloadDeps } from '../src/tools/download.js';
import { validateCachedDownload } from '../src/tools/download-file.js';
import { classifyMaterial, materialFingerprint, AcquisitionError } from '../src/material-acquisition.js';
import { resolveMaterial } from '../src/resolve-material.js';
import type { BrowserSession } from '../src/browser-session.js';
import type { CanvasClient } from '../src/canvas-client.js';

const wrapper = {
  file_id: '3736209', course_id: 147845, display_name: 'Chapter 5', type: 'ExternalTool',
  url: 'https://eclass3.cau.ac.kr/courses/147845/modules/items/3736209',
};

test('semantic routing does not infer video or document from titles and module names', () => {
  assert.equal(classifyMaterial({ ...wrapper, module_name: 'Online lecture' }).asset_kind, 'unresolved');
  assert.equal(classifyMaterial({ ...wrapper, display_name: 'ch05.pdf' }).downloadable, false);
  assert.equal(classifyMaterial({ ...wrapper, external_url: 'https://eclass3.cau.ac.kr/files/55/download' }).downloadable, true);
  assert.equal(classifyMaterial({ type: 'Page' }).asset_kind, 'interactive');
  assert.equal(classifyMaterial({ type: 'movie' }).asset_kind, 'video');
});

test('explicit non-file policies and locked wrappers do not acquire or record downloads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-excluded-'));
  const fileCache = new FileCache(path.join(dir, 'files.db'));
  let acquisitions = 0;
  const unexpectedAcquisition = async () => { acquisitions += 1; throw new Error('unexpected acquisition'); };
  const deps = { session: { resolveExternalToolLaunch: unexpectedAcquisition, downloadCourseresourceFile: unexpectedAcquisition },
    fileCache, token: 'tok' } as unknown as DownloadDeps;
  try {
    for (const [metadata, status] of [
      [{ asset_kind: 'video', downloadable: false, acquisition_policy: 'exclude' }, 'excluded_video'],
      [{ asset_kind: 'interactive', downloadable: false, acquisition_policy: 'exclude' }, 'excluded_interactive'],
      [{ asset_kind: 'unresolved', downloadable: false, acquisition_policy: 'needs_resolution' }, 'needs_resolution'],
      [{ locked_for_user: true }, 'not_open'],
      [{ unlock_at: '2099-01-01T00:00:00Z' }, 'not_open'],
    ] as const) {
      assert.equal((await downloadOne(deps, { ...wrapper, ...metadata })).status, status);
    }
    assert.equal(acquisitions, 0);
    assert.deepEqual(fileCache.list(), []);
  } finally {
    fileCache.getDb().close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unknown launch result is durable across restarts; changed metadata gets a fresh resolution', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-resolution-'));
  const dbPath = path.join(dir, 'files.db');
  let cache = new FileCache(dbPath);
  let launches = 0;
  const session = { resolveExternalToolLaunch: async () => {
    launches += 1;
    throw new AcquisitionError('EXTERNAL_TOOL_NO_ARTIFACT', 'ExternalTool launch did not yield a downloadable file or OCS viewer URL', false);
  } } as unknown as BrowserSession;
  try {
    const first = await downloadOne({ session, fileCache: cache, token: 'tok' }, wrapper);
    assert.equal(first.status, 'needs_resolution');
    cache.getDb().close();
    cache = new FileCache(dbPath);
    assert.equal((await downloadOne({ session, fileCache: cache, token: 'tok' }, wrapper)).status, 'needs_resolution');
    assert.equal(launches, 1);
    const record = cache.getMaterialResolution(wrapper.course_id, wrapper.file_id, materialFingerprint(wrapper))!;
    assert.equal(record.attempt, 1);
    assert.equal(record.error_code, 'EXTERNAL_TOOL_NO_ARTIFACT');
    assert.equal(record.retryable, false);
    await downloadOne({ session, fileCache: cache, token: 'tok' }, { ...wrapper, display_name: 'Chapter 5 revised' });
    assert.equal(launches, 2);
  } finally { cache.getDb().close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('transient launch failures remain retryable and are not reused as terminal resolutions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-retry-'));
  const cache = new FileCache(path.join(dir, 'files.db'));
  let launches = 0;
  const session = { resolveExternalToolLaunch: async () => {
    launches += 1;
    if (launches === 1) throw new AcquisitionError('EXTERNAL_TOOL_HTTP_ERROR', 'ExternalTool launch HTTP 503', true);
    return { kind: 'file', type: 'pdf', url: 'https://eclass3.cau.ac.kr/files/55/download' };
  } } as unknown as BrowserSession;
  try {
    const first = await downloadOne({ session, fileCache: cache, token: 'tok' }, wrapper);
    assert.equal(first.status, 'failed'); assert.equal(first.retryable, true);
    assert.equal(first.failure_kind, 'failed_retryable'); assert.equal(first.next_action, 'retry_with_backoff');
    const second = await resolveMaterial(session, cache, wrapper.course_id, wrapper);
    assert.equal(second.downloadable, true); assert.equal(launches, 2);
  } finally { cache.getDb().close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('getMaterials resolves real PDF evidence and preserves locked items without launching them', async () => {
  let launches = 0;
  const client = { fetchAll: async () => [
    { id: 1, name: 'Online lecture', items: [{ id: 11, title: 'Chapter 5', type: 'ExternalTool', html_url: '/courses/1/modules/items/11' }] },
    { id: 2, name: 'Week 6', state: 'locked', items: [{ id: 12, title: 'Chapter 6', type: 'ExternalTool', html_url: '/courses/1/modules/items/12' }] },
  ] } as unknown as CanvasClient;
  const session = { resolveExternalToolLaunch: async () => { launches += 1; return { kind: 'file', type: 'pdf', url: 'https://eclass3.cau.ac.kr/files/55/download' }; } } as unknown as BrowserSession;
  const result = await getMaterials(client, session, 1, ['external'], undefined, { resolveExternal: true });
  assert.equal(result.materials[0].type, 'ExternalTool');
  assert.equal(result.materials[0].asset_kind, 'document'); assert.equal(result.materials[0].downloadable, true);
  assert.equal(result.materials[1].acquisition_policy, 'not_open'); assert.equal(launches, 1);
  assert.deepEqual(result.errors, []);
});

test('an ExternalTool with verified document policy can use an OCS file intercept', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-ocs-document-'));
  const localPath = path.join(dir, 'slides.pdf'); await fs.writeFile(localPath, 'pdf');
  let intercepts = 0;
  const cache = new FileCache(path.join(dir, 'files.db'));
  const session = { downloadCourseresourceFile: async (_course: number, _id: string, _name: string, _dir: string, url: string) => {
    assert.equal(url, 'https://ocs.cau.ac.kr/em/verified-slides'); intercepts += 1; return localPath;
  } } as unknown as BrowserSession;
  const item = { ...wrapper, asset_kind: 'document' as const, downloadable: true,
    acquisition_policy: 'download' as const, url: 'https://ocs.cau.ac.kr/em/verified-slides' };
  try {
    assert.equal((await downloadOne({ session, fileCache: cache, token: 'tok' }, item)).status, 'downloaded');
    assert.equal((await downloadOne({ session, fileCache: cache, token: 'tok' }, item)).status, 'skipped');
    assert.equal(intercepts, 1);
  } finally { cache.getDb().close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('equal titles and local byte sizes cannot satisfy a different ID or course cache lookup', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-cache-'));
  const localPath = path.join(dir, 'ch05.pdf'); await fs.writeFile(localPath, 'pdf');
  const other = { local_path: localPath, size_bytes: 3, course_id: 147845 };
  const cache = { get: () => null, findByName: () => other, record: () => { throw new Error('must not alias ID'); } };
  try {
    assert.equal(await validateCachedDownload(cache, wrapper), null);
    assert.equal(await validateCachedDownload({ ...cache, get: () => other }, { ...wrapper, course_id: 1 }), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('different IDs with the same PDF title keep separate downloaded bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-storage-'));
  const originalDir = process.env.ECLASS_DOWNLOAD_DIR;
  const originalFetch = globalThis.fetch;
  process.env.ECLASS_DOWNLOAD_DIR = dir;
  globalThis.fetch = (async (input: string | URL | Request) => new Response(String(input).endsWith('/1/download') ? 'first' : 'second',
    { headers: { 'content-type': 'application/pdf' } })) as typeof fetch;
  const cache = new FileCache(path.join(dir, 'files.db'));
  const deps = { session: {} as BrowserSession, fileCache: cache, token: 'tok' };
  try {
    const first = await downloadOne(deps, { file_id: '1', course_id: 1, display_name: 'ch05.pdf', type: 'pdf', url: 'https://eclass3.cau.ac.kr/files/1/download' });
    const second = await downloadOne(deps, { file_id: '2', course_id: 1, display_name: 'ch05.pdf', type: 'pdf', url: 'https://eclass3.cau.ac.kr/files/2/download' });
    assert.equal(first.status, 'downloaded'); assert.equal(second.status, 'downloaded');
    assert.notEqual(first.local_path, second.local_path);
    assert.equal(await fs.readFile(first.local_path!, 'utf8'), 'first');
    assert.equal(await fs.readFile(second.local_path!, 'utf8'), 'second');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDir === undefined) delete process.env.ECLASS_DOWNLOAD_DIR; else process.env.ECLASS_DOWNLOAD_DIR = originalDir;
    cache.getDb().close(); await fs.rm(dir, { recursive: true, force: true });
  }
});

test('server-observed lock remains not_open after HTTP wrapper resolution', async () => {
  const session = {resolveExternalToolLaunch:async()=>{throw new AcquisitionError('MATERIAL_NOT_OPEN','LearningX material is not open',false);}} as unknown as BrowserSession;
  const resolution=await resolveMaterial(session,undefined,wrapper.course_id,wrapper);
  assert.equal(resolution.acquisition_policy,'not_open');
  assert.equal(resolution.downloadable,false);
  assert.equal(resolution.retryable,false);
});

test('a locked HTTP resolution is rechecked after the server opens the material', async () => {
  let current: any;
  let calls=0;
  const session={resolveExternalToolLaunch:async()=>{
    calls++;if(calls===1)throw new AcquisitionError('MATERIAL_NOT_OPEN','not open',false);
    return {kind:'ocs_viewer',url:'https://ocs.cau.ac.kr/em/fixture',type:'pdf'};
  }} as unknown as BrowserSession;
  const cache={getMaterialResolution:()=>current,setMaterialResolution:(r:unknown)=>{current=r;}} as unknown as FileCache;
  assert.equal((await resolveMaterial(session,cache,wrapper.course_id,wrapper)).acquisition_policy,'not_open');
  const open=await resolveMaterial(session,cache,wrapper.course_id,wrapper);
  assert.equal(calls,2);assert.equal(open.downloadable,true);assert.equal(open.acquisition_policy,'download');
});

test('download classifies a server-discovered lock as not_open without caller acquisition metadata', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'material-server-lock-'));
  const fileCache = new FileCache(path.join(dir, 'files.db'));
  const deps = { session: { resolveExternalToolLaunch: async () => {
    throw new AcquisitionError('MATERIAL_NOT_OPEN', 'not open', false);
  } }, fileCache, token: 'tok' } as unknown as DownloadDeps;
  try {
    const result = await downloadOne(deps, wrapper);
    assert.equal(result.status, 'not_open');
    assert.equal(result.error_code, 'MATERIAL_NOT_OPEN');
    assert.equal(result.retryable, false);
    assert.equal(result.next_action, 'wait_until_open');
    assert.deepEqual(fileCache.list(), []);
  } finally { fileCache.getDb().close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('LearningX everlec video is consistently excluded from document acquisition', async () => {
  assert.equal(classifyMaterial({ type: ' EVERLEC ' }).asset_kind, 'video');
  const deps = { session: {}, fileCache: {}, token: 'tok' } as unknown as DownloadDeps;
  const result = await downloadOne(deps, { ...wrapper, type: 'everlec', url: 'https://ocs.cau.ac.kr/em/video' });
  assert.equal(result.status, 'excluded_video');
  assert.equal(result.strategy, 'unsupported_streaming_media');
});
