import test from 'node:test';
import assert from 'node:assert/strict';

import { extractLearningxToken, fetchCourseResourceViaApi, parseLtiForm } from '../src/learningx-client.js';
import type { CanvasClient } from '../src/canvas-client.js';

function makeClient(routes: Record<string, unknown | Error>): CanvasClient {
  return {
    async fetchOne(path: string) {
      const value = routes[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected path ${path}`);
      return value;
    },
  } as CanvasClient;
}

test('parseLtiForm extracts action and hidden fields', () => {
  const form = parseLtiForm(`
    <form method="post" action="https://eclass3.cau.ac.kr/learningx/lti/courseresource">
      <input type="hidden" name="oauth_consumer_key" value="abc&amp;123">
      <input type="hidden" name="resource_link_id" value="r1">
    </form>
  `);

  assert.equal(form.action, 'https://eclass3.cau.ac.kr/learningx/lti/courseresource');
  assert.equal(form.fields.get('oauth_consumer_key'), 'abc&123');
  assert.equal(form.fields.get('resource_link_id'), 'r1');
});

test('extractLearningxToken reads xn_api_token cookie', () => {
  const headers = new Headers({ 'set-cookie': 'xn_api_token=tok%20123; Path=/; HttpOnly' });
  assert.equal(extractLearningxToken(headers), 'tok 123');
});

test('extractLearningxToken missing-cookie error does not expose cookie values', () => {
  const headers = new Headers({ 'set-cookie': 'laravel_session=secret-session; Path=/' });
  assert.throws(
    () => extractLearningxToken(headers),
    (err) => err instanceof Error && !err.message.includes('secret-session'),
  );
});

test('fetchCourseResourceViaApi performs sessionless LTI launch and resources_db fetch', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get('Authorization') });

    if (url === 'https://eclass3.cau.ac.kr/lti-launch') {
      return new Response(`
        <form action="https://eclass3.cau.ac.kr/learningx/lti/courseresource">
          <input name="launch" value="ok">
        </form>
      `, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (url === 'https://eclass3.cau.ac.kr/learningx/lti/courseresource') {
      return new Response('', { status: 302, headers: { 'set-cookie': 'xn_api_token=learning-token; Path=/' } });
    }
    if (url === 'https://eclass3.cau.ac.kr/learningx/api/v1/courses/10/resources_db?user_login=student1') {
      return new Response(JSON.stringify([
        { resource_id: 1, title: 'week1.pdf', commons_content: { view_url: 'https://ocs.cau.ac.kr/em/abc' } },
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const client = makeClient({
    '/api/v1/courses/10/external_tools/sessionless_launch?id=3&launch_type=course_navigation': { url: 'https://eclass3.cau.ac.kr/lti-launch' },
    '/api/v1/users/self': { login_id: 'student1' },
  });

  try {
    const items = await fetchCourseResourceViaApi(client, 10, 'fallback-user');
    assert.equal(items.length, 1);
    assert.equal(items[0].id, '1');
    assert.equal(items[0].url, 'https://ocs.cau.ac.kr/em/abc');
    assert.equal(calls.find((call) => call.url.includes('resources_db'))?.auth, 'Bearer learning-token');
    assert.equal(calls.find((call) => call.url.includes('lti-launch'))?.auth, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchCourseResourceViaApi recovers CourseResource tool id from tabs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === 'https://eclass3.cau.ac.kr/lti-launch-17') {
      return new Response('<form action="https://eclass3.cau.ac.kr/learningx/lti/courseresource"><input name="x" value="y"></form>');
    }
    if (url === 'https://eclass3.cau.ac.kr/learningx/lti/courseresource') {
      return new Response('', { status: 200, headers: { 'set-cookie': 'xn_api_token=tok17; Path=/' } });
    }
    if (url.startsWith('https://eclass3.cau.ac.kr/learningx/api/v1/courses/11/resources_db')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  const client = {
    async fetchOne(path: string) {
      if (path.includes('id=3')) throw new Error('Canvas API error 404');
      if (path.endsWith('/tabs')) return [{ id: 'context_external_tool_17', label: '강의자료실' }];
      if (path.includes('id=17')) return { url: 'https://eclass3.cau.ac.kr/lti-launch-17' };
      if (path === '/api/v1/users/self') return { login_id: 'student2' };
      throw new Error(`unexpected path ${path}`);
    },
  } as CanvasClient;

  try {
    const items = await fetchCourseResourceViaApi(client, 11, 'fallback-user');
    assert.deepEqual(items, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('modulebuilder HTTP query returns only open commons material and rejects an invalid envelope', async () => {
  const { fetchModulebuilderViaApi } = await import('../src/learningx-client.js');
  const originalFetch = globalThis.fetch;
  let malformed = false;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/module-launch')) return new Response('<form action="https://eclass3.cau.ac.kr/learningx/lti/courseresource"><input name="launch" value="ok"></form>');
    if (url.endsWith('/lti/courseresource')) return new Response('',{status:302,headers:{'set-cookie':'xn_api_token=module-token; Path=/'}});
    assert.equal(url,'https://eclass3.cau.ac.kr/learningx/api/v1/courses/12345/modules?include_detail=true');
    return new Response(JSON.stringify(malformed ? { unexpected: true } : [{module_items:[
      {module_item_id:11,title:'slides',content_data:{item_content_type:'commons',item_content_data:{content_id:'fixture',content_type:'pdf'}}},
      {module_item_id:12,title:'locked',content_data:{item_content_type:'commons',lecture_period_status:'not_open',item_content_data:{content_id:'secret',content_type:'pdf'}}},
    ]}]));
  };
  const client=makeClient({'/api/v1/courses/12345/external_tools/sessionless_launch?id=3&launch_type=course_navigation':{url:'https://eclass3.cau.ac.kr/module-launch'}});
  try {
    assert.deepEqual(await fetchModulebuilderViaApi(client,12345),[{id:'11',title:'slides',type:'pdf',url:'https://ocs.cau.ac.kr/em/fixture'}]);
    malformed=true;
    await assert.rejects(fetchModulebuilderViaApi(client,12345),/Unexpected LearningX modules response shape/);
    assert.ok(calls.every(url=>!url.includes('/progress')));
  } finally { globalThis.fetch=originalFetch; }
});
