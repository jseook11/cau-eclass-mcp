import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSession } from '../src/browser-session.js';
import { parseResourceItems } from '../src/resource-items.js';

function makeInterceptPage(items: unknown) {
  return {
    on() {},
    async goto() {},
    url: () => 'https://eclass3.cau.ac.kr/courses/1/external_tools/3',
    async title() { return ''; },
    isClosed: () => false,
    waitForResponse: () => Promise.resolve({ json: async () => items }),
  };
}

function makeSession(apiFetcher: () => Promise<unknown>, browserItems: unknown) {
  const session = new BrowserSession('tester', async () => 'pw');
  (session as any).getClient = async () => ({});
  (session as any).ensurePlaywrightReady = async () => {};
  (session as any).courseResourceApiFetcher = apiFetcher;
  (session as any).withAuthenticatedContext = async (
    _label: string,
    _options: unknown,
    fn: (context: unknown) => Promise<unknown>,
  ) => {
    return fn({
      newPage: async () => makeInterceptPage(browserItems),
      on() {},
    });
  };
  return session;
}

test('interceptCourseresource recovers the resource list after a fetch failure', async () => {
  const expected = [{ id: '7', title: '강의자료', url: 'https://eclass3.cau.ac.kr/files/7', type: 'file' }];
  const session = makeSession(async () => {
    throw new Error('LearningX API error 500');
  }, expected);

  const items = await session.interceptCourseresource(1);

  assert.deepEqual(items, expected);
});

test('interceptCourseresource returns successfully fetched resources', async () => {
  const expected = [{ id: '1', title: '강의자료', url: null, type: 'file' }];
  const session = makeSession(async () => expected, expected);

  const items = await session.interceptCourseresource(1);

  assert.deepEqual(items, expected);
});

test('parseResourceItems rejects an unexpected shape in strict mode and returns no items otherwise', () => {
  assert.throws(() => parseResourceItems({ unexpected: true }, { strict: true }), Error);
  assert.deepEqual(parseResourceItems({ unexpected: true }), []);
});
