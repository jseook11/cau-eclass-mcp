import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEclassServer } from '../src/server.js';
import type { EclassServerContext } from '../src/server.js';
import type { BrowserSession } from '../src/browser-session.js';
import type { FileCache } from '../src/file-cache.js';
import type { ExamCache } from '../src/exam-cache.js';

async function withClient(
  overrides: Partial<EclassServerContext>,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createEclassServer({
    username: 'test',
    session: { getClient: async () => { throw new Error('Unexpected authentication'); } } as unknown as BrowserSession,
    fileCache: { get: () => undefined, listCachedCourses: () => [] } as unknown as FileCache,
    examCache: {} as ExamCache,
    ...overrides,
  });
  const client = new Client({ name: 'structured-errors-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    // This caches outputSchema and enables real SDK output validation.
    await client.listTools();
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function assertFailure(result: Awaited<ReturnType<Client['callTool']>>, code: string): void {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.ok, false);
  assert.equal(result.structuredContent?.error_code, code);
  assert.equal(typeof result.structuredContent?.message, 'string');
  assert.equal(typeof result.structuredContent?.retryable, 'boolean');
  const text = result.content.find((item) => item.type === 'text');
  assert.ok(text?.type === 'text');
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
}

test('invalid inputs return structured errors through the SDK before authentication', async () => {
  let authCalls = 0;
  await withClient({ session: { getClient: async () => { authCalls++; throw new Error('Should not log in'); } } as unknown as BrowserSession }, async (client) => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['eclass_get_materials', { course_id: -1 }, 'course_id'],
      ['eclass_get_courses', { scope: 'invalid' }, 'scope'],
      ['eclass_get_assignments', { days_ahead: 0 }, 'days_ahead'],
      ['eclass_list_exam_sources', { refresh: 'invalid' }, 'refresh'],
      ['eclass_search_syllabus', { query: '' }, 'query'],
      ['eclass_get_download_status', { course_id: -1 }, 'course_id'],
      ['eclass_remove_download', { course_id: -1 }, 'course_id'],
      ['eclass_download_file', { course_id: -1, file_id: '', display_name: '' }, 'course_id'],
      ['eclass_submit_assignment', { course_id: -1, assignment_id: -1 }, 'course_id'],
    ];
    for (const [name, args, field] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assertFailure(result, 'INVALID_INPUT');
      assert.equal(result.structuredContent?.retryable, false);
      const issues = result.structuredContent?.validation_errors as Array<{ path: string[] }>;
      assert.ok(issues.some((issue) => issue.path[0] === field));
      assert.equal(result.structuredContent?.result, undefined);
    }
    assert.equal(authCalls, 0);
  });
});

test('missing handoff file returns its original error with the common contract', async () => {
  await withClient({}, async (client) => {
    const result = await client.callTool({ name: 'eclass_file_handoff', arguments: { file_id: 'missing' } });
    assertFailure(result, 'FILE_NOT_FOUND');
    assert.equal(result.structuredContent?.code, 'not_found');
    assert.match(String(result.structuredContent?.message), /다운로드 기록을 찾을 수 없습니다/);
    assert.equal(result.structuredContent?.retryable, false);
  });
});

test('exam input errors retain their existing reason and local diagnostics', async () => {
  await withClient({}, async (client) => {
    const result = await client.callTool({ name: 'eclass_get_exam_schedule', arguments: { term: 'invalid' } });
    assertFailure(result, 'INVALID_EXAM_TERM');
    assert.equal(result.structuredContent?.reason, 'INVALID_EXAM_TERM');
    assert.equal(result.structuredContent?.mode, 'local');
    assert.deepEqual(result.structuredContent?.candidates, []);
  });
});

test('unhandled backend failures return a sanitized structured error', async () => {
  await withClient({ session: { getClient: async () => { throw new Error('timeout https://eclass3.cau.ac.kr/path?token=secret-value'); } } as unknown as BrowserSession }, async (client) => {
    const result = await client.callTool({ name: 'eclass_get_courses', arguments: {} });
    assertFailure(result, 'TOOL_ERROR');
    assert.equal(result.structuredContent?.retryable, true);
    assert.match(String(result.structuredContent?.debug), /timeout/);
    assert.doesNotMatch(JSON.stringify(result), /secret-value/);
  });
});

test('missing removal selector and unknown tools have explicit error codes', async () => {
  await withClient({}, async (client) => {
    assertFailure(await client.callTool({ name: 'eclass_remove_download', arguments: {} }), 'INVALID_INPUT');
    assertFailure(await client.callTool({ name: 'nonexistent_tool', arguments: {} }), 'UNKNOWN_TOOL');
  });
});

test('real batch failures retain exclusions but report the failed document through the SDK', async () => {
  await withClient({ session: { getClient: async () => ({ getToken: () => 'test-token' }) } as unknown as BrowserSession }, async (client) => {
    const excluded = { file_id: 'video', display_name: 'video.mp4', type: 'video', url: null };
    const invalidDocument = { file_id: 'document', display_name: 'sample.pdf', type: 'pdf', url: null };
    const result = await client.callTool({
      name: 'eclass_download_materials_batch',
      arguments: { course_id: 1, materials: [excluded, invalidDocument] },
    });
    assertFailure(result, 'TOOL_ERROR');
    assert.match(String(result.structuredContent?.message), /no download locator/);
    assert.equal(result.structuredContent?.retryable, false);
    const outcomes = result.structuredContent?.results as Array<{ status: string }>;
    assert.deepEqual(outcomes.map((item) => item.status), ['excluded_video', 'failed']);
    assert.deepEqual(result.structuredContent?.summary, { total: 2, downloaded: 0, skipped: 0, failed: 1, excluded: 1, needs_resolution: 0, not_open: 0 });

    const normal = await client.callTool({ name: 'eclass_download_materials_batch', arguments: { course_id: 1, materials: [excluded] } });
    assert.equal(normal.isError, false);
    assert.equal(normal.structuredContent?.ok, true);
    assert.equal(normal.structuredContent?.error_code, undefined);
  });
});

test('successful array and binary handoff results retain their existing shapes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-handoff-'));
  const filename = path.join(dir, 'sample.txt');
  fs.writeFileSync(filename, 'sample bytes');
  try {
    await withClient({ fileCache: {
      listCachedCourses: () => [{ course_id: 1, name: 'sample', fetched_at: '2026-10-07' }],
      get: () => ({ file_id: 'sample', display_name: 'sample.txt', local_path: filename, size_bytes: 12 }),
    } as unknown as FileCache }, async (client) => {
      const courses = await client.callTool({ name: 'eclass_get_courses_cached', arguments: {} });
      assert.deepEqual(courses.structuredContent, { result: [{ id: 1, name: 'sample', fetched_at: '2026-10-07' }] });
      const handoff = await client.callTool({ name: 'eclass_file_handoff', arguments: { file_id: 'sample' } });
      assert.equal(handoff.structuredContent?.delivered, true);
      assert.equal(handoff.structuredContent?.ok, undefined);
      const resource = handoff.content[0];
      assert.ok(resource.type === 'resource' && 'blob' in resource.resource);
      assert.equal(Buffer.from(resource.resource.blob, 'base64').toString(), 'sample bytes');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
