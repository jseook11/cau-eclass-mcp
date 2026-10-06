import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanvasTokenCompensationRetentionError,
  buildCanvasTokenRecoveryManualCleanupError,
  buildOcsCaptureFailureMessage,
  isSsoLoginUrl,
  parseCachedSessionCredential,
  parseLearningxBoardLocation,
  parseLearningxBoardPostAttachment,
  redactBrowserDiagnostic,
} from '../src/browser-session.js';

test('LearningX board location parser accepts list and post-detail routes only', () => {
  assert.deepEqual(
    parseLearningxBoardLocation('https://eclass3.cau.ac.kr/learningx/lti/learningx_board/boards/77'),
    { boardId: '77' },
  );
  assert.deepEqual(
    parseLearningxBoardLocation('https://eclass3.cau.ac.kr/learningx/lti/learningx_board/boards/77/posts/901'),
    { boardId: '77', postId: '901' },
  );
  assert.equal(
    parseLearningxBoardLocation('https://attacker.example/learningx/lti/learningx_board/boards/77/posts/901'),
    null,
  );
});

test('LearningX board post parser selects a valid same-origin Canvas attachment', () => {
  assert.deepEqual(parseLearningxBoardPostAttachment({
    attachments: [
      { filename: 'bad.pdf', url: 'https://attacker.example/files/1/download', canvas_file_id: 1 },
      { filename: '  synthetic file.pdf  ', url: '/files/12345/download?verifier=redacted' },
    ],
  }), {
    kind: 'file',
    url: 'https://eclass3.cau.ac.kr/files/12345/download?verifier=redacted',
    type: 'pdf',
    filename: 'synthetic file.pdf',
  });
});

test('LearningX board post parser rejects malformed attachment payloads', () => {
  assert.equal(parseLearningxBoardPostAttachment(null), null);
  assert.equal(parseLearningxBoardPostAttachment({ attachments: 'not-an-array' }), null);
  assert.equal(parseLearningxBoardPostAttachment({
    attachments: [{ filename: 'missing-file-id.pdf', url: '/courses/1' }],
  }), null);
});

test('SSO login URL detection includes the mportal authentication boundary', () => {
  assert.equal(
    isSsoLoginUrl('https://mportal2.cau.ac.kr/common/auth/newSsoLogin.do'),
    true,
  );
  assert.equal(
    isSsoLoginUrl('https://mportal2.cau.ac.kr/common/auth/newSsoLogin.do?returnUrl=%2Fstd'),
    true,
  );
  assert.equal(
    isSsoLoginUrl('https://mportal2.cau.ac.kr/common/auth/newSsoLogin.do/extra'),
    false,
  );
  assert.equal(
    isSsoLoginUrl('https://example.com/common/auth/newSsoLogin.do'),
    false,
  );
});

test('failed compensation retention preserves causes without exposing secrets', () => {
  const error = buildCanvasTokenCompensationRetentionError(
    new Error('operation included super-secret-token'),
    new Error('backend included another-secret'),
  );
  assert.doesNotMatch(error.message, /super-secret-token|another-secret/);
  assert.ok(error.cause instanceof AggregateError);
});

test('ambiguous token creation recovery preserves causes without exposing secrets', () => {
  const error = buildCanvasTokenRecoveryManualCleanupError(
    new Error('transport mentioned super-secret-token'),
    new Error('selection mentioned private-purpose'),
  );
  assert.doesNotMatch(error.message, /super-secret-token|private-purpose/);
  assert.ok(error.cause instanceof AggregateError);
});

test('session credential parsing distinguishes missing and corrupt cache values', () => {
  assert.equal(parseCachedSessionCredential(null), null);
  assert.equal(parseCachedSessionCredential('not-json'), null);
  assert.equal(parseCachedSessionCredential('[]'), null);
  assert.equal(parseCachedSessionCredential('{}'), null);
  assert.deepEqual(
    parseCachedSessionCredential('{"cookies":[],"origins":[]}'),
    { cookies: [], origins: [] },
  );
});

test('browser diagnostics redact signed and session-bearing URL queries', () => {
  const diagnostic = redactBrowserDiagnostic(
    '302 https://eclass3.cau.ac.kr/login?access_token=token-value&sig=signed-value&page=2 ' +
    '/relative?session=relative-session-value',
  );
  assert.doesNotMatch(diagnostic, /token-value|signed-value|relative-session-value/);
  assert.match(diagnostic, /page=2/);

  const message = buildOcsCaptureFailureMessage({
    resourceId: '1',
    displayName: 'file.pdf',
    finalPageUrl: 'https://ocs.cau.ac.kr/view?session=session-value',
    pageTitle: 'Viewer',
    recentFrames: ['https://ocs.cau.ac.kr/frame?verifier=verify-value'],
    recentRequests: ['GET https://ocs.cau.ac.kr/file?access_token=request-value'],
    recentResponses: ['302 https://ocs.cau.ac.kr/next?sig=response-value'],
    mediaCandidates: [],
    videoSources: [],
    iframeSources: ['/player?token=relative-frame-token'],
  });
  assert.doesNotMatch(
    message,
    /session-value|verify-value|request-value|response-value|relative-frame-token/,
  );
});
