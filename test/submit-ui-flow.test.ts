import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserSession } from '../src/browser-session.js';

interface Submission {
  files: string[];
  comment: string | undefined;
  pledgeChecked: boolean;
}

function makeMockPage() {
  const state = {
    url: '',
    formOpen: false,
    files: [] as string[],
    comment: undefined as string | undefined,
    pledgeChecked: false,
    submissions: [] as Submission[],
  };

  function makeLocator(name: string) {
    return {
      first() { return this; },
      async isVisible() { return true; },
      async click() {
        if (name === 'open') {
          state.formOpen = true;
        } else if (name === 'submit') {
          assert.equal(state.formOpen, true, 'the submission form must be open');
          assert.ok(state.files.length > 0, 'the files must be selected before submission');
          assert.equal(state.pledgeChecked, true, 'the visible pledge must be accepted before submission');
          state.submissions.push({
            files: [...state.files],
            comment: state.comment,
            pledgeChecked: state.pledgeChecked,
          });
        }
      },
      async setInputFiles(files: string[]) {
        assert.equal(name, 'file-input');
        assert.equal(state.formOpen, true);
        state.files = [...files];
      },
      async fill(value: string) {
        assert.equal(name, 'comment');
        assert.equal(state.formOpen, true);
        state.comment = value;
      },
      async check() {
        assert.equal(name, 'pledge');
        assert.equal(state.formOpen, true);
        state.pledgeChecked = true;
      },
    };
  }

  const page = {
    async goto(url: string) { state.url = url; },
    url: () => state.url,
    isClosed: () => false,
    locator(selector: string) {
      if (selector.includes('submit_assignment_link')) return makeLocator('open');
      if (selector.includes('uploaded_data')) return makeLocator('file-input');
      if (selector.includes('submission[comment]')) return makeLocator('comment');
      if (selector.includes('turnitin_pledge')) return makeLocator('pledge');
      if (selector.includes('과제 제출')) return makeLocator('submit');
      return makeLocator(selector);
    },
    waitForResponse: () => Promise.resolve({ ok: () => true, status: () => 200 }),
  };
  return { page, state };
}

function makePatchedSession(page: ReturnType<typeof makeMockPage>['page']) {
  const session = new BrowserSession('tester', async () => 'pw');
  (session as any).ensurePlaywrightReady = async () => {};
  (session as any).getClient = async () => ({});
  (session as any).withAuthenticatedContext = async (
    _label: string,
    _options: unknown,
    fn: (context: unknown) => Promise<unknown>,
  ) => fn({ newPage: async () => page });
  return session;
}

test('submitAssignmentViaUi submits the requested files and comment after completing the form', async () => {
  const { page, state } = makeMockPage();
  const session = makePatchedSession(page);
  const files = ['/tmp/report.pdf', '/tmp/appendix.pdf'];

  await session.submitAssignmentViaUi(1, 10, files, '검토 부탁드립니다');

  assert.equal(new URL(state.url).pathname, '/courses/1/assignments/10');
  assert.equal(state.submissions.length, 1, 'the assignment must only be submitted once');
  assert.deepEqual(state.submissions[0], {
    files,
    comment: '검토 부탁드립니다',
    pledgeChecked: true,
  });
});

test('submitAssignmentViaUi submits without a comment when none is provided', async () => {
  const { page, state } = makeMockPage();
  const session = makePatchedSession(page);

  await session.submitAssignmentViaUi(1, 10, ['/tmp/report.pdf']);

  assert.equal(state.submissions.length, 1, 'the assignment must only be submitted once');
  assert.deepEqual(state.submissions[0], {
    files: ['/tmp/report.pdf'],
    comment: undefined,
    pledgeChecked: true,
  });
});
