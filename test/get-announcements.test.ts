import test from 'node:test';
import assert from 'node:assert/strict';

import { getAnnouncements } from '../src/tools/get-announcements.js';
import type { CanvasClient } from '../src/canvas-client.js';

test('getAnnouncements preserves the queried course ID on every announcement', async () => {
  const requested: string[] = [];
  const client = {
    fetchAll: async (path: string) => {
      requested.push(path);
      return [{ id: 7, course_id: 999, title: '휴강 안내' }, { id: 8, title: '수업 안내' }];
    },
  } as unknown as CanvasClient;

  const first = await getAnnouncements(client, 147845);
  const second = await getAnnouncements(client, 147863, 1);

  assert.deepEqual(first.map((announcement) => announcement.course_id), [147845, 147845]);
  assert.deepEqual(second.map((announcement) => announcement.course_id), [147863]);
  assert.deepEqual(requested, [
    '/api/v1/courses/147845/discussion_topics',
    '/api/v1/courses/147863/discussion_topics',
  ]);
});
