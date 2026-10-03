import test from 'node:test';
import assert from 'node:assert/strict';

import { getMaterials, isGetMaterialsToolError } from '../src/tools/get-materials.js';
import type { MaterialSource } from '../src/tools/get-materials.js';
import { CanvasClient } from '../src/canvas-client.js';
import type { CanvasClient as CanvasClientType } from '../src/canvas-client.js';
import type { BrowserSession } from '../src/browser-session.js';
import type { FileCache } from '../src/file-cache.js';
import { downloadOne } from '../src/tools/download.js';

test('ExternalTool wrappers stay unresolved without semantic evidence, even in Online lecture', async () => {
  const result = await getMaterials(mockClient(async () => [{
    id: 1, name: 'Online lecture', items: [{
      id: 3736209, title: 'Chapter 5', type: 'ExternalTool',
      html_url: '/courses/147845/modules/items/3736209',
    }],
  }]), mockSession({ interceptModulebuilder: async () => [{
    id: '3736210', title: 'Chapter 5', type: 'pdf', url: 'https://ocs.cau.ac.kr/em/slides',
  }] }), 147845, ['external', 'modulebuilder']);
  assert.equal(result.materials.length, 2);
  const wrapper = result.materials.find((m) => m.id === '3736209')!;
  assert.equal(wrapper.asset_kind, 'unresolved');
  assert.equal(wrapper.downloadable, false);
  assert.equal(wrapper.acquisition_policy, 'needs_resolution');
  assert.equal(result.materials.find((m) => m.id === '3736210')!.downloadable, true);
});

function mockClient(
  fetchAll: (path: string, params?: Record<string, string>) => Promise<unknown[]>,
): CanvasClientType {
  return { fetchAll } as CanvasClientType;
}

function mockSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    interceptCourseresource: async () => [],
    interceptModulebuilder: async () => [],
    ...overrides,
  } as BrowserSession;
}

function mockCache(get: (fileId: string) => unknown): FileCache {
  return { get } as FileCache;
}

test('getMaterials preserves announcement provenance when another source represents the attachment', async () => {
  const client = mockClient(async () => [{
    id: 20, title: '강의자료 안내', attachments: [{
      id: 55, display_name: 'slides.pdf', 'content-type': 'application/pdf',
      url: 'https://ocs.cau.ac.kr/em/slides',
    }],
  }]);
  const session = mockSession({ interceptCourseresource: async () => [{
    id: 'resource-1', title: 'slides.pdf', type: 'pdf', url: 'https://ocs.cau.ac.kr/em/slides',
  }] });

  const result = await getMaterials(client, session, 1, ['announcements', 'courseresource']);

  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].source, 'courseresource');
  assert.equal(result.materials[0].announcement_id, '20');
  assert.deepEqual(new Set(result.materials[0].sources), new Set(['courseresource', 'announcements']));
});

test('a shared attachment retains every originating announcement ID despite repeated titles', async () => {
  const result = await getMaterials(mockClient(async () => [20, 21].map((id) => ({
    id, title: '강의자료 안내', attachments: [{
      id: 55, display_name: 'slides.pdf', 'content-type': 'application/pdf',
      url: 'https://eclass3.cau.ac.kr/files/55/download',
    }],
  }))), mockSession(), 1, ['announcements']);

  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].announcement_id, '20');
  assert.deepEqual(new Set(result.materials[0].announcement_ids), new Set(['20', '21']));
});

test('locked and future Canvas modules stay not_open without a launch, download, or retry', async () => {
  for (const module of [
    { state: 'locked', unlock_at: '2099-09-17T15:00:00Z' },
    { state: 'locked' },
    { state: null, unlock_at: '2099-09-17T15:00:00Z' },
    { state: 'unlocked', unlock_at: '2099-09-17T15:00:00Z', itemUnlockAt: '2020-01-01T00:00:00Z' },
  ]) {
    const client = mockClient(async () => [{
      id: 3, name: '3주차', ...module,
      items: [{ id: 11, title: 'Chapter 5', type: 'ExternalTool',
        html_url: '/courses/1/modules/items/11',
        content_details: { unlock_at: module.itemUnlockAt },
      }],
    }]);
    const session = mockSession({
      resolveExternalToolLaunch: async () => { throw new Error('locked material must not launch'); },
      downloadCourseresourceFile: async () => { throw new Error('locked material must not download'); },
    });
    const result = await getMaterials(client, session, 1, ['external'], undefined, { resolveExternal: true });
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.materials.length, 1);
    const material = result.materials[0];
    assert.equal(material.acquisition_policy, 'not_open');
    assert.equal(material.downloadable, false);
    const outcome = await downloadOne({ session, token: 'tok', fileCache: mockCache(() => { throw new Error('locked material must not use file cache'); }) }, {
      ...material, file_id: material.id, course_id: 1, display_name: material.title,
    });
    assert.equal(outcome.status, 'not_open');
    assert.equal(outcome.retryable, false);
    assert.equal(outcome.next_action, 'wait_until_open');
  }
});

test('getMaterials returns materials and errors when one source fails', async () => {
  const client = mockClient(async (path) => {
    if (path.includes('/modules')) {
      return [
        {
          id: 1,
          name: 'Week 1',
          items: [{ id: 10, title: 'intro.pdf', type: 'File', html_url: '/courses/1/files/10' }],
        },
      ];
    }
    if (path.includes('/files')) {
      throw new Error('Canvas API error 500 https://eclass3.cau.ac.kr/api/v1/courses/1/files?access_token=secret');
    }
    return [];
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules', 'files']);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.equal(result.course_id, 1);
  assert.deepEqual(result.sources.requested, ['modules', 'files']);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, ['files']);
  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].title, 'intro.pdf');
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].source, 'files');
  assert.equal(result.errors[0].retryable, true);
  assert.doesNotMatch(result.errors[0].reason, /access_token=secret/);
  assert.deepEqual(result.warnings, []);
});

test('getMaterials returns ok false when all requested sources fail', async () => {
  const client = mockClient(async () => {
    throw new Error('Canvas API error 500');
  });
  const session = mockSession({
    interceptCourseresource: async () => {
      throw new Error('Playwright navigation timeout');
    },
  });

  const result = await getMaterials(client, session, 1, ['files', 'courseresource']);

  assert.equal(result.ok, false);
  assert.equal(isGetMaterialsToolError(result), true);
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.sources.succeeded, []);
  assert.deepEqual(result.sources.failed, ['files', 'courseresource']);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map((error) => error.source), ['files', 'courseresource']);
  assert.deepEqual(result.warnings, []);
});

test('getMaterials treats a not-started modulebuilder as an empty successful source', async () => {
  const result = await getMaterials(
    mockClient(async () => []),
    mockSession({
      interceptModulebuilder: async () => [],
    }),
    147863,
    ['modulebuilder'],
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.sources.succeeded, ['modulebuilder']);
  assert.deepEqual(result.sources.failed, []);
  assert.deepEqual(result.errors, []);
});

test('getMaterials does not duplicate the Canvas host for absolute module URLs', async () => {
  const client = mockClient(async () => [
    {
      id: 1,
      name: 'Week 1',
      items: [
        {
          id: 10,
          title: 'lecture.pdf',
          type: 'File',
          html_url: 'https://eclass3.cau.ac.kr/courses/1/files/10',
        },
        {
          id: 11,
          title: 'lecture video',
          type: 'ExternalTool',
          html_url: 'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
        },
      ],
    },
  ]);

  const result = await getMaterials(client, mockSession(), 1, ['modules', 'external']);

  assert.equal(result.ok, true);
  assert.equal(result.materials.length, 2);
  assert.deepEqual(new Set(result.materials.map((material) => material.url)), new Set([
    'https://eclass3.cau.ac.kr/courses/1/files/10',
    'https://eclass3.cau.ac.kr/courses/1/modules/items/11',
  ]));
});

test('getMaterials returns ok true when all sources succeed with no materials', async () => {
  const client = mockClient(async () => []);

  const result = await getMaterials(client, mockSession(), 1, ['modules']);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('getMaterials reports files 401 and 403 as non-retryable errors', async () => {
  for (const status of [401, 403]) {
    const client = mockClient(async () => {
      throw new Error(`Canvas API error ${status}`);
    });

    const result = await getMaterials(client, mockSession(), 1, ['files']);

    assert.equal(result.ok, false);
    assert.equal(isGetMaterialsToolError(result), true);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].source, 'files');
    assert.equal(result.errors[0].retryable, false);
  }
});

test('getMaterials suppresses repeated Files permission-denied requests during the cooldown', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({
      status: '권한이 없음',
      errors: [{ message: '사용자에게 이 동작을 수행할 권한이 없음' }],
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const client = new CanvasClient(
    'https://eclass3.cau.ac.kr',
    'token',
  );
  const courseId = 9139260;

  try {
    const first = await getMaterials(client, mockSession(), courseId, ['files']);
    const second = await getMaterials(client, mockSession(), courseId, ['files']);

    assert.equal(first.errors[0].retryable, false);
    assert.equal(second.errors[0].retryable, false);
    assert.equal(first.errors[0].source, 'files');
    assert.equal(second.errors[0].source, 'files');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getMaterials does not duplicate results when a source is requested repeatedly', async () => {
  const client = mockClient(async () => [{
    id: 1,
    name: 'Week 1',
    items: [{ id: 10, title: 'intro.pdf', type: 'File', html_url: '/courses/1/files/10' }],
  }]);

  const result = await getMaterials(
    client,
    mockSession(),
    1,
    ['modules', 'modules', 'modules'] as MaterialSource[],
  );

  assert.deepEqual(result.sources.requested, ['modules']);
  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].id, '10');
  assert.equal(result.materials[0].title, 'intro.pdf');
});

test('getMaterials merges the same opened weekly item from modulebuilder and external', async () => {
  const client = mockClient(async () => [
    {
      id: 1,
      name: '1주차',
      items: [{
        id: 3707021,
        title: 'algorithm_01.1_introduction',
        type: 'ExternalTool',
        html_url: '/courses/147863/modules/items/3707021',
      }],
    },
  ]);
  const session = mockSession({
    interceptModulebuilder: async () => [{
      id: '3707021',
      title: 'algorithm_01.1_introduction',
      type: 'movie',
      url: 'https://ocs.cau.ac.kr/em/lecture-content-id',
    }],
  });

  const result = await getMaterials(client, session, 147863, ['external', 'modulebuilder']);

  assert.equal(result.materials.length, 1);
  const material = result.materials[0];
  assert.equal(material.id, '3707021');
  assert.equal(material.title, 'algorithm_01.1_introduction');
  assert.equal(material.type, 'movie');
  assert.equal(material.url, 'https://ocs.cau.ac.kr/em/lecture-content-id');
  assert.equal(material.module_name, '1주차');
  assert.deepEqual(new Set(material.sources), new Set(['modulebuilder', 'external']));
  assert.equal(material.asset_kind, 'video');
  assert.equal(material.downloadable, false);
  assert.equal(material.acquisition_policy, 'exclude');
});

test('getMaterials preserves ExternalTool type and both playwright flags for wrapper items', async () => {
  const client = mockClient(async () => [
    {
      id: 1,
      name: '1주차',
      items: [{
        id: 11,
        title: 'week1 slides',
        type: 'ExternalTool',
        html_url: '/courses/1/modules/items/11',
      }],
    },
  ]);

  const result = await getMaterials(client, mockSession(), 1, ['external']);

  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].type, 'ExternalTool');
  assert.equal(result.materials[0].url, 'https://eclass3.cau.ac.kr/courses/1/modules/items/11');
  assert.equal(result.materials[0].is_playwright_required, true);
  assert.equal(result.materials[0].is_playright_required, true);
});

test('getMaterials merges Canvas file aliases across modules and announcements', async () => {
  const client = mockClient(async (path) => {
    if (path.includes('/modules')) {
      return [{
        id: 1,
        name: '1주차',
        items: [{
          id: 10,
          title: 'lecture.pdf',
          type: 'File',
          html_url: '/courses/1/files/55?module_item_id=10',
        }],
      }];
    }
    if (path.includes('/discussion_topics')) {
      return [{
        id: 20,
        title: '강의자료 안내',
        attachments: [{
          id: 55,
          display_name: 'lecture.pdf',
          url: 'https://eclass3.cau.ac.kr/files/55/download?download_frd=1',
          'content-type': 'application/pdf',
        }],
      }];
    }
    return [];
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules', 'announcements']);

  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].source, 'announcements');
  assert.equal(result.materials[0].announcement_id, '20');
  assert.deepEqual(new Set(result.materials[0].sources), new Set(['announcements', 'modules']));
});

test('getMaterials merges a module item and its Canvas file while retaining the download URL', async () => {
  const client = mockClient(async (path) => {
    if (path.includes('/modules')) {
      return [{
        id: 1,
        name: '1주차',
        items: [{
          id: 10,
          content_id: 55,
          title: 'lecture.pdf',
          type: 'File',
          html_url: '/courses/1/modules/items/10',
        }],
      }];
    }
    if (path.includes('/files')) {
      return [{
        id: 55,
        display_name: 'lecture.pdf',
        url: 'https://eclass3.cau.ac.kr/files/55/download?verifier=signed',
        'content-type': 'application/pdf',
      }];
    }
    return [];
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules', 'files']);

  assert.equal(result.materials.length, 1);
  const material = result.materials[0];
  assert.equal(material.id, '10');
  assert.equal(material.canvas_file_id, '55');
  assert.equal(material.title, 'lecture.pdf');
  assert.equal(material.url, 'https://eclass3.cau.ac.kr/files/55/download?verifier=signed');
  assert.deepEqual(new Set(material.sources), new Set(['modules', 'files']));
  assert.equal(material.url_source, 'files');
  assert.equal(material.module_name, '1주차');
  assert.equal(material.asset_kind, 'document');
  assert.equal(material.downloadable, true);
  assert.equal(material.acquisition_policy, 'download');
});

test('getMaterials does not merge File module items with missing content_id', async () => {
  const client = mockClient(async () => [{
    id: 1,
    name: '1주차',
    items: [
      {
        id: 10,
        content_id: '',
        title: 'lecture.pdf',
        type: 'File',
        html_url: '/courses/1/modules/items/10',
      },
      {
        id: 11,
        content_id: null,
        title: 'lecture.pdf',
        type: 'File',
        html_url: '/courses/1/modules/items/11',
      },
    ],
  }]);

  const result = await getMaterials(client, mockSession(), 1, ['modules']);

  assert.equal(result.materials.length, 2);
  assert.deepEqual(new Set(result.materials.map((material) => material.id)), new Set(['10', '11']));
});

test('getMaterials removes repeated records within one source', async () => {
  const duplicate = {
    id: 'resource-1',
    title: 'lecture.pdf',
    type: 'pdf',
    url: 'https://ocs.cau.ac.kr/em/resource-1',
  };
  const result = await getMaterials(
    mockClient(async () => []),
    mockSession({ interceptCourseresource: async () => [duplicate, duplicate] }),
    1,
    ['courseresource'],
  );

  assert.equal(result.materials.length, 1);
  assert.deepEqual(result.materials[0].sources, ['courseresource']);
});

test('getMaterials keeps distinct items that only share a title', async () => {
  const result = await getMaterials(
    mockClient(async () => []),
    mockSession({
      interceptCourseresource: async () => [
        { id: 'resource-1', title: '강의자료.pdf', type: 'pdf', url: null },
        { id: 'resource-2', title: '강의자료.pdf', type: 'pdf', url: null },
      ],
    }),
    1,
    ['courseresource'],
  );

  assert.equal(result.materials.length, 2);
  assert.deepEqual(new Set(result.materials.map((material) => material.id)), new Set(['resource-1', 'resource-2']));
});

test('getMaterials default sources omit the permission-sensitive Files API', async () => {
  const requestedPaths: string[] = [];
  const client = mockClient(async (path) => {
    requestedPaths.push(path);
    return [];
  });

  const result = await getMaterials(client, mockSession(), 1);

  assert.deepEqual(new Set(result.sources.requested), new Set([
    'modulebuilder',
    'courseresource',
    'announcements',
    'modules',
    'external',
  ]));
  assert.equal(requestedPaths.some((path) => path.includes('/files')), false);
});

test('getMaterials treats empty successful source plus failed source as partial success', async () => {
  const client = mockClient(async (path) => {
    if (path.includes('/modules')) return [];
    throw new Error('Canvas API error 500');
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules', 'files']);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.deepEqual(result.materials, []);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, ['files']);
  assert.equal(result.errors.length, 1);
});

test('getMaterials reports cache failures as warnings without failing material lookup', async () => {
  const client = mockClient(async () => [
    {
      id: 1,
      name: 'Week 1',
      items: [
        { id: 10, title: 'intro.pdf', type: 'File', html_url: '/courses/1/files/10' },
        { id: 11, title: 'week2.pdf', type: 'File', html_url: '/courses/1/files/11' },
      ],
    },
  ]);
  const cache = mockCache(() => {
    throw new Error('SQLite busy');
  });

  const result = await getMaterials(client, mockSession(), 1, ['modules'], cache);

  assert.equal(result.ok, true);
  assert.equal(isGetMaterialsToolError(result), false);
  assert.equal(result.materials.length, 2);
  assert.deepEqual(result.materials.map((material) => material.is_downloaded), [false, false]);
  assert.deepEqual(result.sources.succeeded, ['modules']);
  assert.deepEqual(result.sources.failed, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].source, 'cache');
});
