import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHttpArtifact, isExternalToolLaunchRequested, isOcsViewerUrl } from '../src/external-tool-launch.js';

test('HTTP artifact classification uses MIME and excludes HTML and failed responses', () => {
  const url='https://eclass3.cau.ac.kr/files/55/download';
  assert.equal(classifyHttpArtifact({url,status:200,contentType:'application/pdf'})?.type,'pdf');
  assert.equal(classifyHttpArtifact({url,status:200,contentType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'})?.type,'pptx');
  assert.equal(classifyHttpArtifact({url,status:206,contentType:'video/mp4'})?.kind,'video');
  assert.equal(classifyHttpArtifact({url:`${url}.pdf`,status:200,contentType:'text/html'}),null);
  assert.equal(classifyHttpArtifact({url,status:503,contentType:'application/pdf'}),null);
  assert.equal(classifyHttpArtifact({url,status:200,contentDisposition:'attachment; filename="report.zip"'})?.kind,'file');
});

test('OCS locator classification requires the verified HTTPS origin', () => {
  const url='https://ocs.cau.ac.kr/em/fixture';
  assert.deepEqual(classifyHttpArtifact({url,status:200,contentType:'text/html'}),{kind:'ocs_viewer',url,type:'ocs'});
  assert.equal(isOcsViewerUrl('http://ocs.cau.ac.kr/em/fixture'),false);
  assert.equal(isOcsViewerUrl('https://ocs.cau.ac.kr.attacker.example/em/fixture'),false);
});

test('launch selection accepts canonical flag and legacy input aliases', () => {
  assert.equal(isExternalToolLaunchRequested({requires_launch:true}),true);
  assert.equal(isExternalToolLaunchRequested({type:'ExternalTool'}),true);
  assert.equal(isExternalToolLaunchRequested({is_playwright_required:true}),true);
  assert.equal(isExternalToolLaunchRequested({is_playright_required:true}),true);
  assert.equal(isExternalToolLaunchRequested({type:'File'}),false);
});
