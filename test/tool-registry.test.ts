import test from 'node:test';
import assert from 'node:assert/strict';

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { buildToolList, listOutputSchemaNames, normalizeToolResult, outputSchemaFor } from '../src/tools/registry.js';
import { normalizeToolError } from '../src/errors.js';

test('buildToolList preserves local tools and adds annotations', () => {
  const tools = buildToolList([
    {
      name: 'eclass_get_courses_cached',
      description: 'cached courses',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'eclass_submit_assignment',
      description: 'submit',
      inputSchema: { type: 'object', properties: {} },
    },
  ]);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...byName.keys()], ['eclass_get_courses_cached', 'eclass_submit_assignment']);
  assert.equal(byName.get('eclass_get_courses_cached')?.annotations?.readOnlyHint, true);
  assert.equal(byName.get('eclass_submit_assignment')?.annotations?.readOnlyHint, false);
  assert.equal(byName.get('eclass_submit_assignment')?.annotations?.destructiveHint, true);
});

test('buildToolList attaches an object outputSchema to every exposed tool', () => {
  const eclassNames = [
    'eclass_get_courses',
    'eclass_get_courses_cached',
    'eclass_doctor',
    'eclass_get_assignments',
    'eclass_get_assignment_detail',
    'eclass_get_grades',
    'eclass_sync_course_metadata',
    'eclass_sync_exam_schedules',
    'eclass_get_exam_schedule',
    'eclass_list_exam_sources',
    'eclass_search_syllabus',
    'eclass_get_syllabus',
    'eclass_submit_assignment',
    'eclass_search_downloads',
    'eclass_export_course_snapshot',
    'eclass_get_announcements',
    'eclass_get_materials',
    'eclass_download_file',
    'eclass_download_materials_batch',
    'eclass_download_video',
    'eclass_list_downloads',
    'eclass_get_download_status',
    'eclass_remove_download',
    'eclass_file_handoff',
  ];
  const tools = buildToolList(
    eclassNames.map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
    })),
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const name of eclassNames) {
    const schema = byName.get(name)?.outputSchema;
    assert.ok(schema, `${name} should have an outputSchema`);
    assert.equal(schema?.type, 'object', `${name} outputSchema must be an object`);
  }

  // 배열 반환 도구는 structuredContent.result 래퍼로 기술돼야 한다(normalizeToolResult와 일치).
  const arrayResultTools = [
    'eclass_get_courses',
    'eclass_get_courses_cached',
    'eclass_get_assignments',
    'eclass_get_announcements',
    'eclass_list_downloads',
  ];
  for (const name of arrayResultTools) {
    const props = byName.get(name)?.outputSchema?.properties as Record<string, { type?: string }> | undefined;
    assert.ok(props?.result, `${name} outputSchema should wrap an array in 'result'`);
    assert.equal(props?.result.type, 'array', `${name} 'result' should be an array`);
  }

  const handoffProps = byName.get('eclass_file_handoff')?.outputSchema?.properties as Record<string, { type?: string }> | undefined;
  assert.equal(handoffProps?.delivered?.type, 'boolean');
});

test('announcement output schemas require course provenance and expose attachment provenance', () => {
  const tools = buildToolList(['eclass_get_announcements', 'eclass_get_materials'].map((name) => ({
    name, description: name, inputSchema: { type: 'object' as const, properties: {} },
  })));
  const announcements = tools.find((tool) => tool.name === 'eclass_get_announcements')!.outputSchema!;
  const announcementProps = announcements.properties as { result: { items: { required: string[] } } };
  assert.ok(announcementProps.result.items.required.includes('id'));
  assert.ok(announcementProps.result.items.required.includes('course_id'));

  const materials = tools.find((tool) => tool.name === 'eclass_get_materials')!.outputSchema!;
  const materialProps = materials.properties as { materials: { items: { properties: Record<string, { type: string }> } } };
  assert.equal(materialProps.materials.items.properties.announcement_id.type, 'string');
  assert.equal(materialProps.materials.items.properties.announcement_ids.type, 'array');
});

test('explicit tool outputSchema is preserved over the registry default', () => {
  const custom = { type: 'object' as const, properties: { custom: { type: 'string' } } };
  const tools = buildToolList([
    {
      name: 'eclass_get_courses',
      description: 'courses',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: custom,
    },
  ]);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(byName.get('eclass_get_courses')?.outputSchema, custom);
});

test('normalizeToolResult preserves text JSON and adds structuredContent', () => {
  const result = normalizeToolResult({
    content: [{ type: 'text', text: JSON.stringify([{ id: 1, name: '운영체제' }]) }],
  });

  assert.deepEqual(JSON.parse(result.content[0].type === 'text' ? result.content[0].text : 'null'), [
    { id: 1, name: '운영체제' },
  ]);
  assert.deepEqual(result.structuredContent, {
    result: [{ id: 1, name: '운영체제' }],
  });
});

test('output validation accepts complete errors without weakening success or error requirements', () => {
  const validate = new AjvJsonSchemaValidator().getValidator(outputSchemaFor('eclass_file_handoff')!);
  assert.equal(validate({ file_id: 'sample', delivered: true }).valid, true);
  assert.equal(validate({ ok: false, error_code: 'FILE_NOT_FOUND', message: 'missing', retryable: false }).valid, true);
  assert.equal(validate({ delivered: true }).valid, false, 'success still requires file_id');
  assert.equal(validate({ file_id: 'sample', delivered: 'yes' }).valid, false, 'success still validates types');
  assert.equal(validate({ ok: false, error_code: 'FILE_NOT_FOUND', message: 'missing' }).valid, false, 'errors require retryable');
  assert.equal(validate({ ok: false, file_id: 'sample', delivered: false }).valid, false, 'an incomplete error cannot pass as success');
});

test('every output schema accepts the common error envelope without weakening the contract', () => {
  const names = listOutputSchemaNames();
  assert.ok(names.length > 0, 'expected registered output schemas');
  for (const name of names) {
    const validate = new AjvJsonSchemaValidator().getValidator(outputSchemaFor(name)!);
    const envelope = { ok: false, error_code: 'SOME_ERROR', message: 'failed', retryable: false };
    assert.equal(validate(envelope).valid, true, `${name} must accept the common error envelope`);
    for (const missing of ['ok', 'error_code', 'message', 'retryable'] as const) {
      const incomplete: Record<string, unknown> = { ...envelope };
      delete incomplete[missing];
      assert.equal(validate(incomplete).valid, false, `${name} must reject an error missing '${missing}'`);
    }
  }
});

test('normalizeToolError derives message and retryable from nested diagnostics', () => {
  const fromSources = normalizeToolError({
    ok: false,
    course_id: 1,
    materials: [],
    errors: [
      { source: 'modules', reason: 'Canvas API error 404', retryable: false },
      { source: 'files', reason: 'Canvas API error 503', retryable: true },
    ],
  }, '도구 실행에 실패했습니다.');
  assert.equal(fromSources.error_code, 'TOOL_ERROR');
  assert.equal(fromSources.message, 'Canvas API error 404');
  assert.equal(fromSources.retryable, true, 'any retryable nested diagnostic makes the result retryable');

  const itemOutcomes = normalizeToolError({
    ok: false,
    course_id: 1,
    results: [{ status: 'failed', message: 'OCS 동영상 다운로드 중 오류', retryable: true }],
  }, 'fallback');
  assert.equal(itemOutcomes.message, 'OCS 동영상 다운로드 중 오류');
  assert.equal(itemOutcomes.retryable, true);

  const explicit = normalizeToolError({
    ok: false,
    error_code: 'EXPLICIT',
    message: 'keep me',
    retryable: false,
    errors: [{ reason: 'ignored', retryable: true }],
  }, 'fallback');
  assert.equal(explicit.message, 'keep me', 'an explicit message wins over nested diagnostics');
  assert.equal(explicit.retryable, false, 'an explicit retryable wins over nested diagnostics');

  const reasonOnly = normalizeToolError({ ok: false, reason: 'NO_SCHEDULES', candidates: [] }, 'fallback');
  assert.equal(reasonOnly.error_code, 'NO_SCHEDULES');
  assert.equal(reasonOnly.message, 'fallback');
  assert.equal(reasonOnly.retryable, false);
});

test('mixed batch errors describe failures instead of normal exclusions', () => {
  const results = [
    { status: 'downloaded', message: 'download complete' },
    { status: 'excluded_video', message: '동영상 제외', retryable: false },
    { status: 'needs_resolution', message: '확인이 필요함', retryable: true },
    { status: 'failed', error_code: 'DOWNLOAD_FAILED', message: '문서 다운로드 실패', retryable: false },
  ];
  const normalized = normalizeToolResult({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, course_id: 1, results }) }] });
  assert.equal(normalized.structuredContent?.message, '문서 다운로드 실패');
  assert.equal(normalized.structuredContent?.retryable, false, 'normal exclusions do not make failures retryable');
  assert.deepEqual(normalized.structuredContent?.results, results, 'all outcomes remain available');
  assert.equal(new AjvJsonSchemaValidator().getValidator(outputSchemaFor('eclass_download_materials_batch')!)(normalized.structuredContent).valid, true);

  const normal = normalizeToolResult({ content: [{ type: 'text', text: JSON.stringify({ ok: true, results: results.slice(0, 3) }) }] });
  assert.equal(normal.isError, undefined);
  assert.equal(normal.structuredContent?.ok, true);
});

test('legacy code names cannot collide with object prototype properties', () => {
  for (const code of ['constructor', 'toString', '__proto__']) {
    const error = normalizeToolError({ code }, 'fallback');
    assert.equal(error.error_code, code);
    assert.equal(new AjvJsonSchemaValidator().getValidator(outputSchemaFor('eclass_file_handoff')!)(error).valid, true);
  }
});
