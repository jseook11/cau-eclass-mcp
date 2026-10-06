import test from 'node:test';
import assert from 'node:assert/strict';

import { buildToolList, normalizeToolResult } from '../src/tools/registry.js';

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
