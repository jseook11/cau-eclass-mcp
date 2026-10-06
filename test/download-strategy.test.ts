import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDownloadStrategy, isResolvedHttpStrategy, isDirectStrategy } from '../src/download-strategy.js';

test('resolveDownloadStrategy classifies streaming media as unsupported', () => {
  assert.equal(resolveDownloadStrategy('https://eclass3.cau.ac.kr/x', 'mp4'), 'unsupported_streaming_media');
  assert.equal(resolveDownloadStrategy(null, 'video'), 'unsupported_streaming_media');
  assert.equal(resolveDownloadStrategy('https://x/y.m3u8', 'hls'), 'unsupported_streaming_media');
});

test('resolveDownloadStrategy maps null url to missing_locator', () => {
  assert.equal(resolveDownloadStrategy(null, 'pdf'), 'missing_locator');
  assert.equal(resolveDownloadStrategy(undefined), 'missing_locator');
  assert.equal(resolveDownloadStrategy(''), 'missing_locator');
});

test('resolveDownloadStrategy maps OCS viewer url to ocs_http', () => {
  assert.equal(resolveDownloadStrategy('https://ocs.cau.ac.kr/em/69d860ed40663', 'pdf'), 'ocs_http');
});

test('resolveDownloadStrategy maps eclass3 url to canvas_file', () => {
  assert.equal(resolveDownloadStrategy('https://eclass3.cau.ac.kr/files/123/download', 'application/pdf'), 'canvas_file');
});

test('resolveDownloadStrategy never classifies ExternalTool wrapper URLs as canvas_file', () => {
  const wrapper = 'https://eclass3.cau.ac.kr/courses/147863/modules/items/3707021';
  assert.equal(resolveDownloadStrategy(wrapper, 'ExternalTool'), 'external_tool_launch');
  assert.equal(resolveDownloadStrategy(wrapper, 'pdf', true), 'external_tool_launch');
  assert.notEqual(resolveDownloadStrategy(wrapper, 'ExternalTool'), 'canvas_file');
});

test('resolveDownloadStrategy prefers ExternalTool flag over an eclass3 host', () => {
  assert.equal(
    resolveDownloadStrategy('https://eclass3.cau.ac.kr/courses/1/modules/items/11', 'File', true),
    'external_tool_launch',
  );
});

test('resolveDownloadStrategy still uses missing_locator for empty URLs without a launch flag', () => {
  assert.equal(resolveDownloadStrategy(null, 'pdf'), 'missing_locator');
});

test('resolveDownloadStrategy maps other hosts to direct_url', () => {
  assert.equal(resolveDownloadStrategy('https://files.example.com/a.pdf'), 'direct_url');
  assert.equal(resolveDownloadStrategy('not-a-url'), 'direct_url');
});

test('strategy group helpers', () => {
  assert.ok(isResolvedHttpStrategy('ocs_http'));
  assert.ok(!isResolvedHttpStrategy('missing_locator'));
  assert.ok(isResolvedHttpStrategy('external_tool_launch'));
  assert.ok(!isResolvedHttpStrategy('canvas_file'));
  assert.ok(isDirectStrategy('canvas_file'));
  assert.ok(isDirectStrategy('direct_url'));
  assert.ok(!isDirectStrategy('ocs_http'));
});
