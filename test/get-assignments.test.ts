import test from 'node:test';
import assert from 'node:assert/strict';

import { getAssignments } from '../src/tools/get-assignments.js';
import type { CanvasClient } from '../src/canvas-client.js';

function mockClient(
  fetchAll: (path: string, params?: Record<string, string>) => Promise<unknown[]>,
): CanvasClient {
  return { fetchAll } as CanvasClient;
}

test('getAssignments returns normalized assignment metadata for a selected course', async () => {
  const client = mockClient(async () => {
    return [
      {
        id: '10',
        name: '보고서',
        due_at: '2099-06-20T12:00:00Z',
        created_at: '2099-06-01T12:00:00Z',
        html_url: 'https://eclass3.cau.ac.kr/courses/1/assignments/10',
        submission_types: ['online_upload'],
        allowed_extensions: ['pdf', 'hwp'],
        allowed_attempts: -1,
        submission: { submitted_at: null, workflow_state: 'unsubmitted', missing: false },
      },
    ];
  });

  const result = await getAssignments(client, 1, 30, true);

  assert.equal(result.length, 1);
  assert.equal(result[0].assignment_id, 10);
  assert.equal(result[0].title, '보고서');
  assert.equal(result[0].due_at, '2099-06-20T21:00:00.000+09:00');
  assert.equal(result[0].url, 'https://eclass3.cau.ac.kr/courses/1/assignments/10');
  assert.equal(result[0].is_submitted, false);
  assert.equal(result[0].is_missing, false);
  assert.deepEqual(result[0].submission_types, ['online_upload']);
  assert.deepEqual(result[0].allowed_extensions, ['pdf', 'hwp']);
  assert.equal(result[0].allowed_attempts, -1);
});

test('getAssignments excludes submitted course assignments when requested', async () => {
  const client = mockClient(async () => [
    {
      id: 10,
      name: 'submitted',
      due_at: '2099-06-20T12:00:00Z',
      submission: { submitted_at: '2099-06-12T12:00:00Z', workflow_state: 'submitted' },
    },
    {
      id: 11,
      name: 'todo',
      due_at: '2099-06-21T12:00:00Z',
      submission: { submitted_at: null, workflow_state: 'unsubmitted' },
    },
  ]);

  const result = await getAssignments(client, 1, 30, false);

  assert.deepEqual(result.map((assignment) => assignment.title), ['todo']);
});

test('getAssignments lists cross-course assignment deadlines and ignores other planner items', async () => {
  const client = mockClient(async () => {
    return [
      {
        plannable_type: 'assignment',
        plannable: { title: 'Planner task', due_at: '2099-06-20T12:00:00Z', created_at: '2099-06-01T12:00:00Z' },
        html_url: '/courses/1/assignments/10',
        submissions: { submitted: false, missing: false },
        context_name: '물리',
        course_id: 1,
      },
      {
        plannable_type: 'calendar_event',
        plannable: { title: '학과 행사', due_at: '2099-06-20T12:00:00Z' },
      },
    ];
  });

  const result = await getAssignments(client, undefined, 30, true);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Planner task');
  assert.equal(result[0].course_name, '물리');
  assert.equal(result[0].due_at, '2099-06-20T21:00:00.000+09:00');
  assert.equal(result[0].url, 'https://eclass3.cau.ac.kr/courses/1/assignments/10');
  assert.equal(result[0].is_submitted, false);
});
