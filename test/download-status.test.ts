import test from 'node:test';
import assert from 'node:assert/strict';

import { getDownloadStatus } from '../src/tools/get-download-status.js';

test('getDownloadStatus summarizes downloads with cached course names', () => {
  const result = getDownloadStatus(
    [
      {
        file_id: 'a',
        course_id: 10,
        display_name: 'week1.pdf',
        local_path: '/tmp/week1.pdf',
        downloaded_at: '2026-04-16T09:00:00.000Z',
        size_bytes: 100,
      },
      {
        file_id: 'b',
        course_id: 10,
        display_name: 'week2.pdf',
        local_path: '/tmp/week2.pdf',
        downloaded_at: '2026-04-16T10:00:00.000Z',
        size_bytes: 300,
      },
      {
        file_id: 'c',
        course_id: 20,
        display_name: 'notes.pdf',
        local_path: '/tmp/notes.pdf',
        downloaded_at: '2026-04-15T10:00:00.000Z',
        size_bytes: 50,
      },
    ],
    [
      { course_id: 10, name: '운영체제', fetched_at: '2026-04-16T12:00:00.000Z' },
    ],
  );

  assert.equal(result.mode, 'summary');
  if (result.mode !== 'summary') {
    throw new Error('expected summary mode');
  }

  assert.equal(result.total_file_count, 3);
  assert.equal(result.total_size_bytes, 450);
  assert.equal(result.courses.length, 2);
  const courses = new Map(result.courses.map((course) => [course.course_id, course]));
  const knownCourse = courses.get(10)!;
  assert.equal(knownCourse.course_name, '운영체제');
  assert.equal(knownCourse.file_count, 2);
  assert.equal(knownCourse.total_size_bytes, 400);
  assert.equal(knownCourse.last_downloaded_at, '2026-04-16T10:00:00.000Z');

  const unnamedCourse = courses.get(20)!;
  assert.ok(unnamedCourse.course_name.trim(), 'uncached courses have a display label');
  assert.equal(unnamedCourse.file_count, 1);
  assert.equal(unnamedCourse.total_size_bytes, 50);
  assert.equal(unnamedCourse.last_downloaded_at, '2026-04-15T10:00:00.000Z');
});

test('getDownloadStatus returns detail mode for a single course', () => {
  const result = getDownloadStatus(
    [
      {
        file_id: 'a',
        course_id: 10,
        display_name: 'week1.pdf',
        local_path: '/tmp/week1.pdf',
        downloaded_at: '2026-04-16T09:00:00.000Z',
        size_bytes: 100,
      },
    ],
    [
      { course_id: 10, name: '운영체제', fetched_at: '2026-04-16T12:00:00.000Z' },
    ],
    10,
  );

  assert.equal(result.mode, 'detail');
  if (result.mode !== 'detail') {
    throw new Error('expected detail mode');
  }

  assert.equal(result.course_id, 10);
  assert.equal(result.course_name, '운영체제');
  assert.equal(result.total_file_count, 1);
  assert.equal(result.total_size_bytes, 100);
  assert.equal(result.downloads.length, 1);
});
