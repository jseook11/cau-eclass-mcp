import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpSession } from '../src/http-session.js';
import { downloadOcsDocument, parseOcsDocumentUrl, parseOcsFileViewerUrl, resolveHttpExternalTool, fetchLearningxBoardMaterials } from '../src/http-materials.js';
import type { CanvasClient } from '../src/canvas-client.js';
const base = 'https://eclass3.cau.ac.kr';
const wrapper = `${base}/courses/1/modules/items/11`;
const board = `${base}/learningx/lti/learningx_board/boards/77`;
const api = `${base}/learningx/api/v1/learningx_board/courses/1/boards/77/posts`;
const metadata = (id='fixture', type='sharedocs', locator='/index.php?module=xn_media_content2013&amp;act=dispXn_media_content2013DownloadWebFile&amp;content_id=fixture') => `<content><content_id>${id}</content_id><content_type>${type}</content_type><content_download_uri>${locator}</content_download_uri></content>`;
const unusedClient = { fetchOne: async () => { throw new Error('Unexpected Canvas request'); } } as unknown as CanvasClient;
function makeSession(routes: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string }> = [];
  const session = new HttpSession(null, async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    return routes(String(url), init ?? {});
  });
  return { session, calls };
}
const html = (text: string, headers?: Record<string,string>) => new Response(text, { headers: { 'content-type': 'text/html', ...headers } });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

test('board discovery returns every attachment across posts and pages, retaining signed URLs', async () => {
  const { session, calls } = makeSession(url => {
    if (url === `${api}?page=1&per_page=100`) return json({ items: [{ id: 901, attachment_count: 2 }, { id: 900, attachment_count: 1, is_secret: true }], pagination: { last_page: 2 } });
    if (url === `${api}/901`) return json({ attachments: [
      { filename: '01.pdf', url: '/files/55/download?verifier=fixture', canvas_file_id: 55 },
      { filename: '01_v2.pdf', url: '/files/56/download', canvas_file_id: 56 },
    ] });
    if (url === `${api}?page=2&per_page=100`) return json({ items: [{ id: 902, attachment_count: 1 }], pagination: { last_page: 2 } });
    if (url === `${api}/902`) return json({ attachments: [{ filename: '02.pdf', url: '/files/57/download', canvas_file_id: 57 }] });
    throw new Error('Unexpected endpoint');
  });
  session.cookieValue = () => 'fixture-token';
  const files = await fetchLearningxBoardMaterials(session, unusedClient, 1, { boardId: '77' });
  assert.deepEqual(files.map(f => f.id), ['55', '56', '57']);
  assert.equal(files[0].url, `${base}/files/55/download?verifier=fixture`);
  assert.ok(!calls.some(c => c.url === `${api}/900`));
});

test('a multi-file board wrapper cannot resolve to an arbitrary first attachment', async () => {
  const { session } = makeSession(url => {
    if (url === wrapper) return html(`<iframe src="${board}"></iframe>`);
    if (url === board) return html('board', { 'set-cookie': 'xn_api_token=token; Path=/; Secure' });
    if (url === `${api}?page=1&per_page=100`) return json({ items: [{ id: 901, attachment_count: 2 }], pagination: { last_page: 1 } });
    if (url === `${api}/901`) return json({ attachments: [
      { filename: '01.pdf', url: '/files/55/download' }, { filename: '02.pdf', url: '/files/56/download' },
    ] });
    throw new Error('Unexpected endpoint');
  });
  await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, wrapper), { code: 'EXTERNAL_TOOL_MULTIPLE_ARTIFACTS' });
});

test('OCS parser verifies identity, document type and download endpoint', () => {
  assert.match(parseOcsDocumentUrl('fixture', metadata()), /^https:\/\/ocs.cau.ac.kr\/index.php\?/);
  assert.throws(() => parseOcsDocumentUrl('other', metadata()), /matching document/);
  assert.throws(() => parseOcsDocumentUrl('fixture', metadata('fixture','movie')), /matching document/);
  for (const locator of ['https://attacker.example/file.pdf', '/index.php?content_id=fixture', '/index.php?module=xn_media_content2013&amp;act=dispXn_media_content2013DownloadWebFile&amp;content_id=other']) {
    assert.throws(() => parseOcsDocumentUrl('fixture', metadata('fixture','sharedocs',locator)), /rejected/);
  }
});

test('OCS download streams original bytes, fixes extension and sends no Canvas bearer token', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ocs-http-'));
  const bytes = Buffer.from('%PDF-1.7\nfixture');
  const { session, calls } = makeSession((url, init) => {
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    if (url.includes('content.php')) return new Response(metadata());
    return new Response(bytes, { headers: { 'content-type': 'application/pdf' } });
  });
  try {
    const saved = await downloadOcsDocument(1,'r1','lecture_01.2',dir,'https://ocs.cau.ac.kr/em/fixture',session);
    assert.equal(path.basename(saved),'lecture_01.2.pdf');
    assert.deepEqual(await fs.readFile(saved),bytes);
    assert.equal(calls.length,2);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('OCS rejects video/HTML and removes an interrupted temporary file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ocs-http-'));
  try {
    for (const ct of ['text/html','video/mp4','application/x-mpegurl']) {
      const {session}=makeSession(url=>url.includes('content.php')?new Response(metadata()):new Response('wrong',{headers:{'content-type':ct}}));
      await assert.rejects(downloadOcsDocument(1,'r1','slides',dir,'https://ocs.cau.ac.kr/em/fixture',session),/not return a document/);
    }
    const {session}=makeSession(url=>url.includes('content.php')?new Response(metadata()):new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));c.error(new Error('broken stream'));}}),{headers:{'content-type':'application/pdf'}}));
    await assert.rejects(downloadOcsDocument(1,'r1','slides',dir,'https://ocs.cau.ac.kr/em/fixture',session),/broken stream/);
    assert.deepEqual(await fs.readdir(dir,{recursive:true}).then(paths=>paths.filter(p=>p.endsWith('.part')||p.endsWith('.pdf'))),[]);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('HTTP LTI follows signed POST and board pagination to a Canvas attachment', async () => {
  const {session,calls}=makeSession((url,init)=>{
    if(url===wrapper) return html(`<form action="${board}" method="post"><input name="lti_message_type" value="basic-lti-launch-request"><input name="oauth_signature" value="signed-value"></form>`);
    if(url===board){assert.equal(init.method,'POST');assert.match(String(init.body),/oauth_signature=signed-value/);return html('<div>board</div>',{'set-cookie':'xn_api_token=lx-token; Path=/; Secure; HttpOnly'});}
    assert.equal(new Headers(init.headers).get('Authorization'),'Bearer lx-token');
    if(url===`${api}?page=1&per_page=100`)return json({items:[{id:901,attachment_count:0}],pagination:{last_page:2}});
    if(url===`${api}?page=2&per_page=100`)return json({items:[{id:902,attachment_count:1}],pagination:{last_page:2}});
    if(url===`${api}/902`)return json({attachments:[{filename:'slides.pptx',url:'/files/55/download',canvas_file_id:55}]});
    throw new Error('Unexpected endpoint');
  });
  assert.deepEqual(await resolveHttpExternalTool(session,unusedClient,1,wrapper),{kind:'file',url:`${base}/files/55/download`,type:'pptx',filename:'slides.pptx'});
  assert.ok(calls.every(c=>!/(progress|attendance\/api)/.test(c.url)));
});

test('HTTP LTI resolves direct post routes without reading a board list', async () => {
  const {session,calls}=makeSession(url=>{
    if(url===wrapper)return html(`<iframe src="${board}/posts/901"></iframe>`);
    if(url===`${board}/posts/901`)return html('post',{'set-cookie':'xn_api_token=lx-token; Path=/; Secure'});
    if(url===`${api}/901`)return json({attachments:[{filename:'file.pdf',url:'/files/55/download'}]});
    throw new Error('Unexpected request');
  });
  const artifact=await resolveHttpExternalTool(session,unusedClient,1,wrapper);
  assert.equal(artifact.kind,'file');assert.equal(calls.length,3);
});

test('HTTP LTI rejects cross-course locators and hostile POST forms before sending fields', async () => {
  const {session,calls}=makeSession(()=>html('<form action="https://attacker.example/lti" method="post"><input name="lti_message_type" value="secret"></form>'));
  await assert.rejects(resolveHttpExternalTool(session,unusedClient,2,wrapper),/course locator rejected/);
  assert.equal(calls.length,0);
  await assert.rejects(resolveHttpExternalTool(session,unusedClient,1,wrapper),/form destination rejected/);
  assert.equal(calls.length,1);
});

test('HTTP LTI recognizes file headers without consuming the artifact body', async () => {
  let cancelled=false;
  const {session}=makeSession(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/pdf'}}));
  assert.equal((await resolveHttpExternalTool(session,unusedClient,1,wrapper)).kind,'file');assert.equal(cancelled,true);
});

test('HTTP LTI follows an OCS iframe and reports unknown page formats', async () => {
  const {session,calls}=makeSession(url=>url.includes('content.php')?new Response(metadata()):html('<iframe src="https://ocs.cau.ac.kr/em/fixture"></iframe>'));
  assert.equal((await resolveHttpExternalTool(session,unusedClient,1,wrapper)).kind,'ocs_viewer');assert.equal(calls.length,2);
  const unknown=makeSession(()=>html('<div>new format</div>')).session;
  await assert.rejects(resolveHttpExternalTool(unknown,unusedClient,1,wrapper),/did not yield/);
});

test('HTTP LTI preserves HTTP failure and session expiration as distinct errors', async () => {
  const broken=makeSession(()=>new Response('unavailable',{status:503})).session;
  await assert.rejects(resolveHttpExternalTool(broken,unusedClient,1,wrapper),e=>(e as {code:string}).code==='EXTERNAL_TOOL_HTTP_ERROR');
  const expired=makeSession(()=>html('<input name="login_user_password">')).session;
  await assert.rejects(resolveHttpExternalTool(expired,unusedClient,1,wrapper),e=>(e as {code:string}).code==='EXTERNAL_TOOL_SESSION_EXPIRED');
});

test('HTTP lecture resolution matches the requested module item and excludes locked content', async () => {
  const originalFetch=globalThis.fetch;
  let locked=false;
  const {session,calls}=makeSession(url=>{
    if(url===wrapper)return new Response(null,{status:302,headers:{location:`${base}/learningx/lti/lecture_attendance/items/view/22`}});
    return html('<div>lecture</div>');
  });
  globalThis.fetch=async(input)=>{
    const url=String(input);
    if(url.endsWith('/launch'))return html(`<form action="${base}/learningx/lti/courseresource"><input name="launch" value="yes"></form>`);
    if(url.endsWith('/lti/courseresource'))return new Response('',{status:302,headers:{'set-cookie':'xn_api_token=token; Path=/'}});
    assert.equal(url,`${base}/learningx/api/v1/courses/1/modules?include_detail=true`);
    return json([{module_items:[
      {module_item_id:10,content_data:{item_content_type:'commons',item_content_data:{content_id:'wrong',content_type:'pdf'}}},
      {module_item_id:11,content_data:{item_content_type:'commons',lecture_period_status:locked?'not_open':'open',item_content_data:{content_id:'fixture',content_type:'pdf'}}},
    ]}]);
  };
  const client={fetchOne:async()=>({url:`${base}/launch`})} as unknown as CanvasClient;
  try {
    assert.equal((await resolveHttpExternalTool(session,client,1,wrapper)).url,'https://ocs.cau.ac.kr/em/fixture');
    locked=true;
    await assert.rejects(resolveHttpExternalTool(session,client,1,wrapper),e=>(e as {code:string}).code==='MATERIAL_NOT_OPEN');
    assert.ok(calls.every(c=>c.method==='GET'));
  } finally {globalThis.fetch=originalFetch;}
});

test('OCS download carries scoped session cookies on metadata and original file without Canvas authorization', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocs-cookies-'));
  const { session } = makeSession((url, init) => {
    if (url === `${base}/seed`) return html('ok', { 'set-cookie': 'canvas_only=private; Path=/; Secure' });
    if (url === 'https://ocs.cau.ac.kr/seed') return html('ok', { 'set-cookie': 'ocs_session=authorized; Path=/; Secure' });
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), 'ocs_session=authorized');
    assert.equal(headers.get('authorization'), null);
    if (url.includes('content.php')) return new Response(metadata());
    return new Response('%PDF-1.7\nfixture', { headers: { 'content-type': 'application/pdf' } });
  });
  try {
    await session.request(`${base}/seed`);
    await session.request('https://ocs.cau.ac.kr/seed');
    await downloadOcsDocument(1, 'r1', 'slides', dir, 'https://ocs.cau.ac.kr/em/fixture', session);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('HTTP LTI skips malformed, tracking and visited passive targets before a valid OCS iframe', async () => {
  const { session, calls } = makeSession(url => url.includes('content.php') ? new Response(metadata())
    : html(`<iframe src="http://["></iframe><iframe src="https://tracker.example/pixel"></iframe><iframe src="${wrapper}"></iframe><iframe src="https://ocs.cau.ac.kr/em/fixture"></iframe>`));
  assert.equal((await resolveHttpExternalTool(session, unusedClient, 1, wrapper)).kind, 'ocs_viewer');
  assert.ok(calls.every(c => !c.url.includes('tracker.example')));
  assert.equal(calls.filter(c => c.url === wrapper).length, 1);
});

test('HTTP LTI falls through unsupported iframe candidates to a literal redirect', async () => {
  const { session, calls } = makeSession(url => url.includes('content.php') ? new Response(metadata())
    : html('<iframe src="about:blank"></iframe><iframe src="https://tracker.example/pixel"></iframe><script>window.location="https://ocs.cau.ac.kr/em/fixture";</script>'));
  assert.equal((await resolveHttpExternalTool(session, unusedClient, 1, wrapper)).kind, 'ocs_viewer');
  assert.equal(calls.length, 2);
});

test('HTTP LTI cancels an oversized page stream', async () => {
  let cancelled = false;
  const { session } = makeSession(() => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, wrapper), /Oversized LTI page/);
  assert.equal(cancelled, true);
});

test('HTTP board limits detailed post requests and passes one deadline signal throughout', async () => {
  let details = 0;
  let deadline: AbortSignal | undefined;
  const { session } = makeSession((url, init) => {
    if (url === wrapper) return html(`<iframe src="${board}"></iframe>`);
    if (url === board) return html('board', { 'set-cookie': 'xn_api_token=token; Path=/; Secure' });
    assert.ok(init.signal instanceof AbortSignal);
    if (!deadline) deadline = init.signal as AbortSignal;
    assert.equal(init.signal, deadline);
    if (url.includes('?page=')) return json({ items: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, attachment_count: 1 })) });
    details++;
    return json({ attachments: [] });
  });
  await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, wrapper), e => (e as { code: string }).code === 'EXTERNAL_TOOL_LIMIT_REACHED');
  assert.equal(details, 50);
});

test('HTTP board reacquires a token when a cookie has malformed percent encoding', async () => {
  const originalFetch = globalThis.fetch;
  let launches = 0;
  globalThis.fetch = async input => String(input).endsWith('/launch')
    ? html(`<form action="${base}/learningx/lti/courseresource"><input name="launch" value="yes"></form>`)
    : new Response('', { status: 302, headers: { 'set-cookie': 'xn_api_token=fresh; Path=/' } });
  const client = { fetchOne: async () => { launches++; return { url: `${base}/launch` }; } } as unknown as CanvasClient;
  const { session } = makeSession((url, init) => {
    if (url === wrapper) return html(`<iframe src="${board}/posts/901"></iframe>`);
    if (url === `${board}/posts/901`) return html('post', { 'set-cookie': 'xn_api_token=%ZZ; Path=/; Secure' });
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fresh');
    return json({ attachments: [{ filename: 'slides.pdf', url: '/files/55/download' }] });
  });
  try {
    assert.equal((await resolveHttpExternalTool(session, client, 1, wrapper)).kind, 'file');
    assert.equal(launches, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('HTTP board reports its expired overall deadline without issuing detail requests', async () => {
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => milliseconds === 60_000
    ? AbortSignal.abort(new DOMException('Expired', 'TimeoutError')) : originalTimeout(milliseconds);
  const { session, calls } = makeSession(url => url === wrapper ? html(`<iframe src="${board}"></iframe>`)
    : html('board', { 'set-cookie': 'xn_api_token=token; Path=/; Secure' }));
  try {
    await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, wrapper), e => (e as { code: string }).code === 'EXTERNAL_TOOL_TIMEOUT');
    assert.equal(calls.length, 2);
  } finally { AbortSignal.timeout = originalTimeout; }
});

test('HTTP LTI explores all session-allowed intermediate hosts', async () => {
  for (const origin of ['https://canvas.cau.ac.kr', 'https://mportal2.cau.ac.kr', 'https://ocs.cau.ac.kr']) {
    const intermediate = `${origin}/bridge`;
    const { session, calls } = makeSession(url => url === wrapper
      ? html(`<iframe src="${intermediate}"></iframe>`)
      : url === intermediate ? html('<iframe src="https://ocs.cau.ac.kr/em/fixture"></iframe>')
      : url.includes('content.php') ? new Response(metadata()) : html('blank'));
    assert.equal((await resolveHttpExternalTool(session, unusedClient, 1, wrapper)).kind, 'ocs_viewer');
    assert.ok(calls.some(call => call.url === intermediate));
  }
});

test('HTTP LTI returns to sibling candidates after a dead end or failed branch', async () => {
  for (const status of [200, 404, 500]) {
    const { session, calls } = makeSession(url => url === wrapper
      ? html(`<iframe src="${base}/blank"></iframe><iframe src="${base}/file.pdf"></iframe>`)
      : url.endsWith('/blank') ? new Response('blank', { status, headers: { 'content-type': 'text/html' } })
      : new Response('%PDF-', { headers: { 'content-type': 'application/pdf' } }));
    assert.equal((await resolveHttpExternalTool(session, unusedClient, 1, wrapper)).kind, 'file');
    assert.equal(calls.length, 3);
  }
});

test('HTTP LTI bounds branching exploration and rejects unsupported destinations', async () => {
  const { session, calls } = makeSession(url => html(url === wrapper
    ? `<iframe src="https://canvas.cau.ac.kr:444/bridge"></iframe><iframe src="https://user@ocs.cau.ac.kr/bridge"></iframe>`
    : 'blank'));
  await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, wrapper), (error: unknown) => (error as { code: string }).code === 'EXTERNAL_TOOL_NO_ARTIFACT');
  assert.equal(calls.length, 1);
  const branching = makeSession(url => html(Array.from({ length: 2 }, (_, index) => `<iframe src="${base}/tree/${encodeURIComponent(url)}/${index}"></iframe>`).join('')));
  await assert.rejects(resolveHttpExternalTool(branching.session, unusedClient, 1, wrapper), (error: unknown) => (error as { code: string }).code === 'EXTERNAL_TOOL_LIMIT_REACHED');
  assert.equal(branching.calls.length, 40);
});

const legacyFileViewer = (id = 'fixture', origin = 'https://ocs.cau.ac.kr') => `<script>var content_id="${id}"; var playerType='File'; var content_type="17";
$('#content_download_iframe').attr('src', "${origin}/index.php?module=xn_media_content2013&act=dispXn_media_content2013DownloadContent&content_id=${id}");</script>`;

test('OCS legacy File viewer validates identity, type and original file destination', () => {
  assert.match(parseOcsFileViewerUrl('fixture', legacyFileViewer()), /DownloadContent/);
  for (const viewer of [legacyFileViewer('other'), legacyFileViewer('fixture', 'https://attacker.example'), legacyFileViewer().replace('"17"', '"9"'), legacyFileViewer().replace("'File'", "'Video'")]) {
    assert.throws(() => parseOcsFileViewerUrl('fixture', viewer));
  }
});

test('OCS legacy File resolves and downloads original bytes when UniPlayer metadata is unsupported', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocs-legacy-'));
  const { session } = makeSession(url => url.includes('content.php') ? new Response('Not Supported Content Type')
    : url.includes('/em/') ? html(legacyFileViewer())
    : new Response('%PDF-legacy', { headers: { 'content-type': 'application/pdf' } }));
  try {
    assert.equal((await resolveHttpExternalTool(session, unusedClient, 1, 'https://ocs.cau.ac.kr/em/fixture')).type, 'file');
    const saved = await downloadOcsDocument(1, 'r1', 'legacy', dir, 'https://ocs.cau.ac.kr/em/fixture', session);
    assert.equal(await fs.readFile(saved, 'utf8'), '%PDF-legacy');
    assert.equal(path.extname(saved), '.pdf');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test('OCS upstream failure pages remain distinct from protocol identity mismatches', async () => {
  const session = makeSession(() => html('<html><body>API Request fail</body></html>')).session;
  await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, 'https://ocs.cau.ac.kr/em/fixture'),
    (error: unknown) => (error as { code: string; retryable: boolean }).code === 'OCS_UPSTREAM_UNAVAILABLE' && (error as { retryable: boolean }).retryable);
});

test('HTTP LTI prefers actionable failures within the same retry class regardless of branch order', async () => {
  for (const reverse of [false, true]) {
    const targets = [`${base}/gone`, 'https://ocs.cau.ac.kr/em/fixture'];
    if (reverse) targets.reverse();
    const { session } = makeSession(url => url === wrapper
      ? html(targets.map(target => `<iframe src="${target}"></iframe>`).join(''))
      : url.endsWith('/gone') ? new Response('missing', { status: 404 })
      : new Response(metadata('other')));
    await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, wrapper),
      (error: unknown) => (error as { code: string }).code === 'EXTERNAL_TOOL_PROTOCOL_ERROR');
  }
});

test('HTTP LTI preserves retry when any failed branch can recover', async () => {
  for (const reverse of [false, true]) {
    const targets = [`${base}/temporary`, 'https://ocs.cau.ac.kr/em/fixture'];
    if (reverse) targets.reverse();
    const { session } = makeSession(url => url === wrapper
      ? html(targets.map(target => `<iframe src="${target}"></iframe>`).join(''))
      : url.endsWith('/temporary') ? new Response('temporary', { status: 500 })
      : new Response(metadata('other')));
    await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, wrapper),
      (error: unknown) => (error as { code: string; retryable: boolean }).code === 'EXTERNAL_TOOL_HTTP_ERROR' && (error as { retryable: boolean }).retryable);
  }
});

test('Legacy OCS resolution does not depend on the server error wording and never overrides XML identity', async () => {
  for (const text of ['Unsupported media format', '<error>Unknown content format</error>']) {
    const { session } = makeSession(url => url.includes('content.php') ? new Response(text) : html(legacyFileViewer()));
    assert.equal((await resolveHttpExternalTool(session, unusedClient, 1, 'https://ocs.cau.ac.kr/em/fixture')).type, 'file');
  }
  const { session, calls } = makeSession(url => url.includes('content.php') ? new Response(metadata('other')) : html(legacyFileViewer()));
  await assert.rejects(resolveHttpExternalTool(session, unusedClient, 1, 'https://ocs.cau.ac.kr/em/fixture'), /identity mismatch/);
  assert.equal(calls.length, 1);
});

test('An LTI POST may instruct a GET to the same URL with a different response', async () => {
  const target = `${base}/learningx/lti/launch`;
  const { session, calls } = makeSession((url, init) => url === wrapper
    ? html(`<form action="${target}" method="post"><input name="lti_message_type" value="basic-lti-launch-request"></form>`)
    : init.method === 'POST' ? html(`<script>window.location="${target}";</script>`)
    : new Response('%PDF-', { headers: { 'content-type': 'application/pdf' } }));
  assert.equal((await resolveHttpExternalTool(session, unusedClient, 1, wrapper)).kind, 'file');
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'GET']);
});
