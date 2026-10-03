import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchEclassDocument } from '../src/tools/standard-search.js';
import type { StandardToolContext } from '../src/tools/standard-search.js';
import type { DownloadRecord } from '../src/file-cache.js';
import { clearHandoffs } from '../src/file-handoff-registry.js';

const record: DownloadRecord = {
  file_id: '3636147',
  course_id: 10,
  display_name: '강의자료.pdf',
  local_path: '/tmp/does-not-need-to-exist.pdf',
  downloaded_at: '2026-03-01T00:00:00.000Z',
  size_bytes: 1234,
};

function contextWith(over: Partial<StandardToolContext>): StandardToolContext {
  return {
    session: { getClient: async () => ({}) } as unknown as StandardToolContext['session'],
    fileCache: { list: () => [record] } as unknown as StandardToolContext['fileCache'],
    examCache: {} as unknown as StandardToolContext['examCache'],
    ...over,
  };
}

test('fetch on a download returns a clickable URL when handoffBaseUrl is set', async () => {
  clearHandoffs();
  const res = await fetchEclassDocument(
    contextWith({ handoffBaseUrl: 'http://127.0.0.1:8787' }),
    'eclass://download/3636147',
  );
  const url = new URL(res.url);
  assert.equal(url.origin, 'http://127.0.0.1:8787');
  assert.ok(url.pathname.startsWith('/files/'));
  assert.equal(res.metadata?.download_url, res.url);
  assert.ok(res.text.includes(res.url));
  // No server-side local path leaked into the model context.
  assert.ok(!res.text.includes('/tmp/'));
});

test('fetch on a download falls back to metadata JSON without handoffBaseUrl (stdio)', async () => {
  clearHandoffs();
  const res = await fetchEclassDocument(contextWith({}), 'eclass://download/3636147');
  assert.equal(JSON.parse(res.text).file_id, record.file_id);
  assert.equal(res.url, 'eclass://download/3636147');
  assert.equal(res.metadata?.download_url, undefined);
});
