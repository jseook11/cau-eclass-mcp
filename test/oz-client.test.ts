import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOzSyllabus, type OzSyllabusInput } from '../src/oz-client.js';
import { Reader, parseHeader } from '../src/oz-protocol.js';
const input = { year:'2026', term:'S', campcd:'1', sust:'3B410', sbjtno1:'15841', clssno1:'01' };
function i(n:number) { const b=Buffer.alloc(4);b.writeInt32BE(n);return b; }
function u(n:number) { const b=Buffer.alloc(2);b.writeUInt16BE(n);return b; }
function utf(s:string) { const b=Buffer.from(s);return Buffer.concat([u(b.length),b]); }
function wide(s:string) { return Buffer.concat([i(s.length),Buffer.from(s,'utf16le').swap16()]); }
function header(name:string, session=false) { return Buffer.concat([i(10001),wide(name),i(session?1:0),...(session?[wide('s'),wide('fresh-session')]:[])]); }
function data(rows: Record<string,string>[], bitTitle = false) {
  const fields = ['YEAR','SHTM','CAMPCD','SUST','SBJTNO','CLSSNO','SBJTNM'];
  const encoded = rows.map(r=>Buffer.concat(fields.map(k=>bitTitle && k==='SBJTNM' ? Buffer.from([255]) : Buffer.concat([Buffer.from([0]),utf(r[k])]))));
  let offset = 0;
  const records = encoded.map(b=>{const r=Buffer.concat([i(b.length),i(offset)]);offset+=b.length;return r;});
  return Buffer.concat([header('oz.framework.cp.message.FrameworkResponseDataModule'),i(0),i(0),Buffer.from([1]),i(17),utf('OZBINDEDDATAMODULE'),i(2040),i(0),i(0),u(1),
    utf('ds_basicinfo'),utf('ByteArraySet'),utf(''),i(fields.length),
    ...fields.flatMap(k=>[i(1),i(bitTitle && k==='SBJTNM' ? -7 : 12),utf(k),Buffer.from([1])]),i(0),i(1),i(offset),i(rows.length),utf(''),i(offset),...records,...encoded]);
}
const basic = {YEAR:'2026',SHTM:'S',CAMPCD:'1',SUST:'3B410',SBJTNO:'15841',CLSSNO:'01',SBJTNM:'합성 과목(TEST)'};
function transport(rows:Record<string,string>[]) {
  let calls=0;
  return (async (url, init) => {
    assert.equal(String(url),'https://rpt80.cau.ac.kr/oz80/server');
    assert.equal(new Headers(init?.headers).has('Cookie'),false);
    assert.equal(init?.redirect,'error');
    const r=new Reader(Buffer.from(init!.body as Uint8Array));const h=parseHeader(r);
    calls++;
    if(calls===1) {
      assert.equal(h.name,'oz.framework.cp.message.repository.OZRepositoryRequestUserLogin');
      return new Response(new Uint8Array(header('oz.framework.cp.message.repository.OZRepositoryResponseUserLogin',true)));
    }
    assert.equal(h.fields.s,'fresh-session');
    return new Response(new Uint8Array(data(rows)));
  }) as typeof fetch;
}
test('operational client creates fresh guest session and maps verified course data',async()=> {
  const doc=await fetchOzSyllabus(input,transport([basic]));
  assert.equal(doc.basic.course_code,'15841');assert.equal(doc.basic.title_ko,'합성 과목');
  assert.match(doc.raw_text,/ds_basicinfo/);
});
test('rejects empty and wrong-course responses before mapping',async()=> {
  await assert.rejects(fetchOzSyllabus(input,transport([])),{code:'SYLLABUS_NOT_FOUND'});
  await assert.rejects(fetchOzSyllabus(input,transport([{...basic,SBJTNO:'99999'}])),{code:'SYLLABUS_IDENTITY_MISMATCH'});
});
test('rejects missing department and sanitizes network failures',async()=> {
  await assert.rejects(fetchOzSyllabus({...input,sust:''},transport([])),{code:'SYLLABUS_INVALID_INPUT'});
  const failed=(async()=>{throw new Error('private-session-value');}) as typeof fetch;
  await assert.rejects(fetchOzSyllabus(input,failed),e=> {
    assert.doesNotMatch((e as Error).message,/private-session-value/);return (e as {code:string}).code==='SYLLABUS_TRANSPORT_FAILED';
  });
});

function responses(...bodies: Buffer[]): typeof fetch {
  return (async () => new Response(new Uint8Array(bodies.shift()!))) as typeof fetch;
}
test('campus is required at runtime and campus identity is checked', async () => {
  let sent = false;
  const never = (async () => { sent = true; throw new Error('must not send'); }) as typeof fetch;
  await assert.rejects(fetchOzSyllabus({ ...input, campcd: undefined } as unknown as OzSyllabusInput, never), { code: 'SYLLABUS_INVALID_INPUT' });
  await assert.rejects(fetchOzSyllabus({ ...input, campcd: '3' }, never), { code: 'SYLLABUS_INVALID_INPUT' });
  assert.equal(sent, false);
  await assert.rejects(fetchOzSyllabus({ ...input, campcd: '2' }, transport([basic])), { code: 'SYLLABUS_IDENTITY_MISMATCH' });
});
test('distinguishes malformed login/data protocol from mapping errors', async () => {
  const login = header('oz.framework.cp.message.repository.OZRepositoryResponseUserLogin', true);
  await assert.rejects(fetchOzSyllabus(input, responses(Buffer.from('private-invalid-wire'))), { code: 'SYLLABUS_PROTOCOL_FAILED' });
  await assert.rejects(fetchOzSyllabus(input, responses(login, Buffer.from('private-invalid-wire'))), { code: 'SYLLABUS_PROTOCOL_FAILED' });
  await assert.rejects(fetchOzSyllabus(input, responses(header('unexpected-private-class', true))), { code: 'SYLLABUS_PROTOCOL_FAILED' });
  await assert.rejects(fetchOzSyllabus(input, responses(login, data([basic], true))), e => {
    assert.doesNotMatch((e as Error).message, /private|Invalid OZ syllabus value/);
    return (e as { code: string }).code === 'SYLLABUS_MAPPING_FAILED';
  });
});
test('HTTP failure and interrupted body reads stay in the transport stage', async () => {
  await assert.rejects(fetchOzSyllabus(input, (async () => new Response('private', { status: 503 })) as typeof fetch), { code: 'SYLLABUS_TRANSPORT_FAILED' });
  const broken = new ReadableStream({ start(c) { c.error(new Error('private-body-secret')); } });
  await assert.rejects(fetchOzSyllabus(input, (async () => new Response(broken)) as typeof fetch), e => {
    assert.doesNotMatch((e as Error).message, /private/);
    return (e as { code: string }).code === 'SYLLABUS_TRANSPORT_FAILED';
  });
});
