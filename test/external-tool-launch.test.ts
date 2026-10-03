import test from 'node:test';
import assert from 'node:assert/strict';
import { AcquisitionError } from '../src/material-acquisition.js';

import {
  isExternalToolLaunchRequested,
  nextLtiFollowAction,
  resolveLaunchFromContext,
  selectLaunchArtifact,
  type LaunchObservation,
  type LtiPageSnapshot,
} from '../src/external-tool-launch.js';

function observation(partial: LaunchObservation): LaunchObservation {
  return partial;
}

test('launch video evidence outranks a generic OCS viewer and excludes failed PDF responses', () => {
  assert.equal(selectLaunchArtifact([
    { source: 'navigation', url: 'https://ocs.cau.ac.kr/em/player' },
    { source: 'response', url: 'https://ocs.cau.ac.kr/video.mp4', status: 206, contentType: 'video/mp4' },
    { source: 'response', url: 'https://eclass3.cau.ac.kr/file.pdf', status: 503, contentType: 'application/pdf' },
  ])?.kind, 'video');
});

test('a video player DOM is semantic video evidence after LTI launch', async () => {
  const result = await resolveLaunchFromContext({
    moduleItemUrl: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    goto: async () => {}, submitForm: async () => {}, observations: () => [],
    readSnapshot: async () => ({ url: 'https://ocs.cau.ac.kr/em/player', forms: [], iframes: [], hasVideo: true }),
  });
  assert.equal(result.kind, 'video');
});

test('launch 5xx, 429 and auth 401 retain a retryable reason instead of no-artifact classification', async () => {
  for (const status of [503, 429, 401, 403]) {
    await assert.rejects(resolveLaunchFromContext({
      moduleItemUrl: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
      goto: async () => {}, submitForm: async () => {},
      observations: () => [{ source: 'response', url: 'https://eclass3.cau.ac.kr/learningx/lti/launch', status, contentType: 'text/html' }],
      readSnapshot: async () => ({ url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11', forms: [], iframes: [] }),
    }), (err: unknown) => err instanceof AcquisitionError && err.code === 'EXTERNAL_TOOL_HTTP_ERROR' && err.retryable === (status !== 403));
  }
});

test('isExternalToolLaunchRequested keeps the misspelled flag as an alias', () => {
  assert.equal(isExternalToolLaunchRequested({ type: 'ExternalTool' }), true);
  assert.equal(isExternalToolLaunchRequested({ is_playwright_required: true }), true);
  assert.equal(isExternalToolLaunchRequested({ is_playright_required: true }), true);
  assert.equal(isExternalToolLaunchRequested({ type: 'File', url: 'https://eclass3.cau.ac.kr/files/1' }), false);
});

test('selectLaunchArtifact finds a PPTX download from a new tab', () => {
  const artifact = selectLaunchArtifact([
    observation({
      source: 'navigation',
      url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    }),
    observation({
      source: 'popup',
      url: 'https://eclass3.cau.ac.kr/files/55/download?download_frd=1',
    }),
    observation({
      source: 'download',
      url: 'https://eclass3.cau.ac.kr/files/55/download?download_frd=1',
      filename: 'week1.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }),
  ]);

  assert.deepEqual(artifact, {
    kind: 'file',
    url: 'https://eclass3.cau.ac.kr/files/55/download?download_frd=1',
    type: 'pptx',
    filename: 'week1.pptx',
  });
});

test('selectLaunchArtifact finds a PDF response inside an iframe', () => {
  const artifact = selectLaunchArtifact([
    observation({
      source: 'iframe',
      url: 'https://eclass3.cau.ac.kr/courses/1/external_tools/retrieve?display=borderless',
    }),
    observation({
      source: 'response',
      url: 'https://eclass3.cau.ac.kr/files/90/download',
      status: 200,
      contentType: 'application/pdf',
    }),
  ]);

  assert.equal(artifact?.kind, 'file');
  assert.equal(artifact?.url, 'https://eclass3.cau.ac.kr/files/90/download');
  assert.equal(artifact?.type, 'pdf');
});

test('selectLaunchArtifact follows a POST LTI form into an OCS viewer URL', () => {
  const artifact = selectLaunchArtifact([
    observation({
      source: 'navigation',
      url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    }),
    observation({
      source: 'navigation',
      url: 'https://eclass3.cau.ac.kr/courses/1/external_tools/retrieve?id=3',
    }),
    observation({
      source: 'navigation',
      url: 'https://ocs.cau.ac.kr/em/69d860ed40663',
    }),
  ]);

  assert.deepEqual(artifact, {
    kind: 'ocs_viewer',
    url: 'https://ocs.cau.ac.kr/em/69d860ed40663',
    type: 'ocs',
  });
});

test('selectLaunchArtifact prefers a PPT download over the Canvas wrapper page', () => {
  const artifact = selectLaunchArtifact([
    observation({
      source: 'response',
      url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
      status: 200,
      contentType: 'text/html',
    }),
    observation({
      source: 'response',
      url: 'https://ocs.cau.ac.kr/em/slide-id',
      status: 200,
      contentType: 'text/html',
    }),
    observation({
      source: 'download',
      url: 'https://eclass3.cau.ac.kr/files/12/download',
      filename: 'slides.ppt',
      contentType: 'application/vnd.ms-powerpoint',
    }),
  ]);

  assert.equal(artifact?.kind, 'file');
  assert.equal(artifact?.filename, 'slides.ppt');
  assert.equal(artifact?.type, 'ppt');
});

test('nextLtiFollowAction submits a Canvas auto-POST form', () => {
  const snapshot: LtiPageSnapshot = {
    url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    forms: [{ id: 'tool_form', action: 'https://eclass3.cau.ac.kr/learningx/lti/launch', method: 'post' }],
    iframes: [],
  };

  assert.deepEqual(nextLtiFollowAction(snapshot, new Set()), {
    type: 'submit_form',
    selector: 'form#tool_form',
  });
});

test('resolveLaunchFromContext submits a POST form then keeps an OCS redirect', async () => {
  const observations: LaunchObservation[] = [
    { source: 'navigation', url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11' },
  ];
  let snapshot: LtiPageSnapshot = {
    url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    forms: [{ id: 'tool_form', action: 'https://eclass3.cau.ac.kr/learningx/lti/launch', method: 'post' }],
    iframes: [],
  };
  const submitted: string[] = [];

  const artifact = await resolveLaunchFromContext({
    moduleItemUrl: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    goto: async (url) => {
      observations.push({ source: 'navigation', url });
    },
    readSnapshot: async () => snapshot,
    submitForm: async (selector) => {
      submitted.push(selector);
      snapshot = {
        url: 'https://ocs.cau.ac.kr/em/69d860ed40663',
        forms: [],
        iframes: [],
      };
      observations.push({ source: 'navigation', url: snapshot.url });
    },
    observations: () => observations,
  });

  assert.deepEqual(submitted, ['form#tool_form']);
  assert.deepEqual(artifact, {
    kind: 'ocs_viewer',
    url: 'https://ocs.cau.ac.kr/em/69d860ed40663',
    type: 'ocs',
  });
});

test('nextLtiFollowAction watches an LTI iframe after the form has been submitted', () => {
  const snapshot: LtiPageSnapshot = {
    url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    forms: [{ id: 'tool_form', action: 'https://eclass3.cau.ac.kr/learningx/lti/launch', method: 'post' }],
    iframes: ['https://ocs.cau.ac.kr/em/content-id'],
  };

  assert.deepEqual(nextLtiFollowAction(snapshot, new Set(['form#tool_form'])), {
    type: 'watch_iframe',
    src: 'https://ocs.cau.ac.kr/em/content-id',
  });
});

test('resolveLaunchFromContext waits for a popup download after LTI opens a new tab', async () => {
  const observations: LaunchObservation[] = [
    { source: 'navigation', url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11' },
  ];
  const artifact = await resolveLaunchFromContext({
    moduleItemUrl: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    goto: async () => undefined,
    readSnapshot: async () => ({
      url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
      forms: [],
      iframes: [],
    }),
    submitForm: async () => {
      throw new Error('no form to submit');
    },
    observations: () => observations,
    wait: async () => {
      observations.push({
        source: 'download',
        url: 'https://eclass3.cau.ac.kr/files/55/download',
        filename: 'week1.pptx',
        contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      });
    },
  });

  assert.equal(artifact.kind, 'file');
  assert.equal(artifact.filename, 'week1.pptx');
});

test('resolveLaunchFromContext accepts a LearningX board attachment', async () => {
  const artifact = await resolveLaunchFromContext({
    moduleItemUrl: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    goto: async () => undefined,
    readSnapshot: async () => ({
      url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
      forms: [],
      iframes: [],
    }),
    submitForm: async () => {
      throw new Error('no form to submit');
    },
    observations: () => [],
    resolveBoardAttachment: async () => {
      return {
        kind: 'file',
        url: 'https://eclass3.cau.ac.kr/files/10683786/download?verifier=redacted',
        type: 'pdf',
        filename: '2026-02, 01.pdf',
      };
    },
  });

  assert.deepEqual(artifact, {
    kind: 'file',
    url: 'https://eclass3.cau.ac.kr/files/10683786/download?verifier=redacted',
    type: 'pdf',
    filename: '2026-02, 01.pdf',
  });
});

test('resolveLaunchFromContext retries while a LearningX board is still loading', async () => {
  let boardLoaded = false;

  const artifact = await resolveLaunchFromContext({
    moduleItemUrl: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
    goto: async () => undefined,
    readSnapshot: async () => ({
      url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
      forms: [],
      iframes: [],
    }),
    submitForm: async () => undefined,
    observations: () => [],
    resolveBoardAttachment: async () => {
      if (!boardLoaded) return undefined;
      return {
        kind: 'file',
        url: 'https://eclass3.cau.ac.kr/files/10683786/download',
        type: 'pdf',
        filename: 'late.pdf',
      };
    },
    wait: async () => {
      boardLoaded = true;
    },
  });

  assert.equal(artifact.kind, 'file');
  assert.equal(artifact.url, 'https://eclass3.cau.ac.kr/files/10683786/download');
  assert.equal(artifact.filename, 'late.pdf');
});
