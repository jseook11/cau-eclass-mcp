import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSession } from '../src/browser-session.js';
import { parseResourceItems } from '../src/resource-items.js';

function makeSession(apiFetcher: () => Promise<unknown>) {
  const session = new BrowserSession('tester', async () => 'pw');
  Object.assign(session, {
    getClient: async () => ({}), courseResourceApiFetcher: apiFetcher,
    ensurePlaywrightReady: async () => { throw new Error('Unexpected browser launch'); },
  });
  return session;
}

test('courseresource surfaces HTTP source failure without launching a browser', async () => {
  const session = makeSession(async () => { throw new Error('LearningX API error 500'); });
  await assert.rejects(session.fetchCourseresources(1), /LearningX API error 500/);
});

test('courseresource returns HTTP resources', async () => {
  const expected = [{ id: '1', title: '강의자료', url: null, type: 'file' }];
  assert.deepEqual(await makeSession(async () => expected).fetchCourseresources(1), expected);
});

test('parseResourceItems rejects an unexpected shape in strict mode and returns no items otherwise', () => {
  assert.throws(() => parseResourceItems({ unexpected: true }, { strict: true }), Error);
  assert.deepEqual(parseResourceItems({ unexpected: true }), []);
});

test('OCS download uses the authenticated BrowserSession HTTP context', async () => {
  const { HttpSession } = await import('../src/http-session.js');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocs-auth-context-'));
  const http = new HttpSession({ cookies: [{ name: 'ocs_auth', value: 'fixture', domain: 'ocs.cau.ac.kr', path: '/', expires: -1 }] }, async (url, init) => {
    assert.equal(new Headers(init?.headers).get('cookie'), 'ocs_auth=fixture');
    if (String(url).includes('content.php')) return new Response('<content><content_id>fixture</content_id><content_type>sharedocs</content_type><content_download_uri>/index.php?module=xn_media_content2013&amp;act=dispXn_media_content2013DownloadWebFile&amp;content_id=fixture</content_download_uri></content>');
    return new Response('%PDF-1.7\nfixture', { headers: { 'content-type': 'application/pdf' } });
  });
  let contexts = 0;
  const session = makeSession(async () => []);
  Object.assign(session, { withHttpSession: async (fn: (session: InstanceType<typeof HttpSession>) => Promise<string>) => { contexts++; return fn(http); } });
  try {
    const saved = await session.downloadCourseresourceFile(1, 'fixture', 'slides', dir, 'https://ocs.cau.ac.kr/em/fixture');
    assert.equal(contexts, 1);
    assert.equal(path.extname(saved), '.pdf');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
