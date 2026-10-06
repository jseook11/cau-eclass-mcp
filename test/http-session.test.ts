import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { HttpSession, parseHtmlForm, SsoPageChangedError } from '../src/http-session.js';
import { createCanvasTokenFromSession, listCanvasTokensFromSession, revokeCanvasTokenFromSession } from '../src/canvas-session-tokens.js';
const BASE = 'https://eclass3.cau.ac.kr';
function sessionWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return new HttpSession(null, ((url, init) => handler(String(url), init!)) as typeof fetch);
}
test('cookie domain/path/expiry and cache roundtrip isolate credentials', async () => {
  const sent: Array<{url:string; cookie:string|null}> = [];
  const session = sessionWith((url, init) => {
    const headers = new Headers();
    if (url.endsWith('/seed')) {
      headers.append('Set-Cookie', 'shared=s; Domain=cau.ac.kr; Path=/; Secure');
      headers.append('Set-Cookie', 'local=l; Path=/profile; Secure');
      headers.append('Set-Cookie', 'expired=x; Max-Age=0; Path=/');
      headers.append('Set-Cookie', 'invalid=x; Domain=ac.kr; Path=/');
    }
    sent.push({url, cookie:new Headers(init.headers).get('cookie')});
    return new Response('', {headers});
  });
  await session.request(`${BASE}/seed`);
  await session.request(`${BASE}/profile/settings`);
  await session.request('https://mportal2.cau.ac.kr/profile/settings');
  await session.request(`${BASE}/profiles`);
  assert.equal(sent[1].cookie, 'local=l; shared=s');
  assert.equal(sent[2].cookie, 'shared=s');
  assert.equal(sent[3].cookie, 'shared=s');
  assert.equal(new HttpSession(session.storageState()).cookieValue('shared', BASE), 's');
  assert.equal(session.storageState().cookies.length, 2);
  await assert.rejects(session.request('https://attacker.example/'), /allowlist/);
});
test('redirects consume intermediate cookies and drop POST body for 302, reject external destinations', async () => {
  let calls = 0;
  const session = sessionWith((url, init) => {
    calls++;
    if (calls===1) return new Response(null, {status:302,headers:{Location:'/next','Set-Cookie':'x=1; Path=/'}});
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get('cookie'), 'x=1');
    return new Response('ok');
  });
  assert.equal((await session.request(`${BASE}/start`, {method:'POST',body:'secret'})).text,'ok');
  const rejected = sessionWith(() => new Response(null, {status:302,headers:{Location:'https://attacker.example/'}}));
  await assert.rejects(rejected.request(BASE), /allowlist/);
});
for (const [variant, markup] of [
  ['double quotes', '<input name="login_user_password"><script>document.forms["form1"].action = "https://canvas.cau.ac.kr/xn-sso/gw-cb.php"</script>'],
  ['single quotes and whitespace', "<input name='login_user_password'><script>document . forms [ 'form1' ] . action = 'https://canvas.cau.ac.kr/xn-sso/gw-cb.php'</script>"],
  ['HTML form', "<form name='form1' action='/xn-sso/gw-cb.php' method='post'><input name='login_user_password'></form>"],
]) test(`SSO decrypts Canvas password with ${variant}`, async () => {
  const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength:1024});
  const key = privateKey.export({type:'pkcs1',format:'pem'}).toString().replace(/\n/g,'');
  const literal = (value: string) => variant === 'single quotes and whitespace' ? `'${value}'` : JSON.stringify(value);
  const cipher = publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_PADDING}, Buffer.from('canvas-password')).toString('base64');
  const session = sessionWith((url, init) => {
    if (url === `${BASE}/`) return new Response(markup.replace("action='/xn-sso/gw-cb.php'", "action='https://canvas.cau.ac.kr/xn-sso/gw-cb.php'"), {headers:{'Set-Cookie':'xn_sso_csrf_token_for_this_login=csrf; Domain=cau.ac.kr; Path=/'}});
    if (url.includes('gw-cb.php')) {
      const fields=new URLSearchParams(String(init.body));assert.equal(fields.get('login_user_password'),'secret');assert.equal(fields.get('csrf_token'),'csrf');
      return new Response(`<form action="${BASE}/login/canvas" method="POST"><input name="pseudonym_session[password]"></form><script>window . loginCryption ( ${literal(cipher)} , ${literal(key)} )</script>`, {headers:{'Set-Cookie':'ssotoken=sso; Domain=cau.ac.kr; Path=/'}});
    }
    if (url.endsWith('/login/canvas')) {
      assert.equal(new URLSearchParams(String(init.body)).get('pseudonym_session[password]'),'canvas-password');
      assert.match(new Headers(init.headers).get('cookie')!, /ssotoken=sso/);
      return new Response('ok', {headers:{'Set-Cookie':'_normandy_session=canvas; Path=/'}});
    }
    assert.equal(url, `${BASE}/api/v1/users/self`);
    assert.match(new Headers(init.headers).get('cookie')!, /_normandy_session=canvas/);
    return Response.json({id:1,name:'Synthetic User'});
  });
  await session.login('synthetic',async()=> 'secret');
  assert.equal(await session.authenticated(),true);
});
test('token creation scopes form fields and supports relative actions; recovery uses CSRF and exact encoded ID', async () => {
  const calls: {url:string;init:RequestInit}[]=[];
  const session = sessionWith((url,init) => {
    calls.push({url,init});
    if (url.endsWith('/profile/settings')) return new Response('<meta name="csrf-token" content="meta-csrf"><form action="/unrelated"><input name="secret" value="other"></form><form action="/profile/tokens"><input name="authenticity_token" value="form-csrf"></form>');
    if (init.method==='POST') return Response.json({id:'new-id',token:'new-secret'});
    if (init.method==='DELETE') return new Response(null,{status:204});
    return Response.json([{id:'listed-id'}]);
  });
  const result=await createCanvasTokenFromSession(session,'2099-01-01','unique-purpose');
  assert.equal(result.bodyParsed,true);
  const fields=new URLSearchParams(String(calls[1].init.body));
  assert.equal(fields.get('authenticity_token'),'form-csrf');assert.equal(fields.has('secret'),false);
  assert.deepEqual(await listCanvasTokensFromSession(session),[{id:'listed-id'}]);
  assert.equal(await revokeCanvasTokenFromSession(session,{id:'old/id'}),true);
  assert.equal(calls.at(-1)!.url,`${BASE}/api/v1/users/self/tokens/old%2Fid`);
  assert.equal(new Headers(calls.at(-1)!.init.headers).get('X-CSRF-Token'),'meta-csrf');
});
test('form parsing is scoped and decodes HTML entities',()=> {
  const f=parseHtmlForm('<form action="/x?a=1&amp;b=2" method="post"><input name="v" value="&#39;&quot;"></form><input name="outside" value="secret">');
  assert.equal(f.fields.get('v'),`'"`);assert.equal(f.fields.has('outside'),false);assert.equal(f.action,'/x?a=1&b=2');
});
test('ordinary portal menu forms are not submitted as authentication forms', async()=> {
  let count=0;
  const session=sessionWith(()=>{count++;return new Response('<form action="/search/menuSearch.do"><input name="q"></form><script>function search(){document.forms[0].submit()}</script>');});
  await session.html('https://mportal2.cau.ac.kr/std/usk/sUskSif002/index.do');
  assert.equal(count,1);
});
test('session instances keep independent user cookies and reject cross-origin POST replay',async()=> {
  const a=sessionWith(()=>new Response('',{headers:{'Set-Cookie':'account=a; Path=/'}}));
  const b=new HttpSession();await a.request(BASE);
  assert.equal(b.cookieValue('account',BASE),undefined);
  const redirected=sessionWith(()=>new Response(null,{status:307,headers:{Location:'https://canvas.cau.ac.kr/next'}}));
  await assert.rejects(redirected.request(BASE,{method:'POST',body:'password'}),/Cross-origin/);
});

test('changed SSO forms and unexpected destinations fail before reading the password', async () => {
  for (const markup of [
    '<input name="renamed_password">',
    '<input name="login_user_password"><script>document.forms["form1"].action="https://attacker.example/gw-cb.php"</script>',
    '<form action="https://canvas.cau.ac.kr/wrong" method="post"><input name="login_user_password"></form>',
  ]) {
    const session = sessionWith(() => new Response(markup, { headers: { 'Set-Cookie': 'xn_sso_csrf_token_for_this_login=csrf; Domain=cau.ac.kr; Path=/' } }));
    let read = false;
    await assert.rejects(session.login('user', async () => { read = true; return 'private-password'; }), e => {
      assert.ok(e instanceof SsoPageChangedError);
      assert.equal(e.code, 'SSO_PAGE_CHANGED');
      assert.doesNotMatch(e.message, /private-password|attacker/);
      return true;
    });
    assert.equal(read, false);
  }
});
test('missing Canvas SSO callback is a page change, not a transport failure', async () => {
  const session = sessionWith(url => url === `${BASE}/`
    ? new Response('<input name="login_user_password"><script>document.forms["form1"].action="https://canvas.cau.ac.kr/xn-sso/gw-cb.php"</script>', { headers: { 'Set-Cookie': 'xn_sso_csrf_token_for_this_login=csrf; Domain=cau.ac.kr; Path=/' } })
    : new Response('changed callback private-server-data'));
  await assert.rejects(session.login('user', async () => 'secret'), { code: 'SSO_PAGE_CHANGED' });
  const offline = sessionWith(() => { throw new Error('private-server-data'); });
  await assert.rejects(offline.login('user', async () => 'secret'), e => {
    assert.equal((e as { code?: string }).code, undefined);
    assert.equal((e as Error).message, 'HTTP session transport failed'); return true;
  });
});

test('Canvas credential form destinations remain restricted after parsing', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const key = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const cipher = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from('private-canvas-password')).toString('base64');
  for (const [action, method] of [
    ['https://canvas.cau.ac.kr/login/canvas', 'POST'],
    [`${BASE}/wrong-path`, 'POST'],
    [`${BASE}/login/canvas`, 'GET'],
  ]) {
    let calls = 0;
    const session = sessionWith(() => {
      calls++;
      if (calls === 1) return new Response('<input name="login_user_password"><script>document.forms["form1"].action="https://canvas.cau.ac.kr/xn-sso/gw-cb.php"</script>', { headers: { 'Set-Cookie': 'xn_sso_csrf_token_for_this_login=csrf; Domain=cau.ac.kr; Path=/' } });
      assert.equal(calls, 2);
      return new Response(`<form action="${action}" method="${method}"><input name="pseudonym_session[password]"></form><script>window.loginCryption(${JSON.stringify(cipher)},${JSON.stringify(key)})</script>`);
    });
    await assert.rejects(session.login('user', async () => 'secret'), { code: 'SSO_PAGE_CHANGED' });
    assert.equal(calls, 2);
  }
});
