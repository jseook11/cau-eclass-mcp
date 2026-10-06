import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSyllabusSearch } from '../src/mportal-client.ts';

test('normalizeSyllabusSearch maps selectList rows and splits college/department', () => {
  const body = { result: [{
    year: '2099', shtm: '1', campcd: '1', sbjtno1: '99999', clssno1: '01',
    sbjtno: '99999-01', kornm: '합성과목', sust: 'X9999',
    colgnm: '테스트대학<br>테스트학부', corscd: '0', shtnm: '전필',
    profnm: '합성교수', ltbdrm: '101관 101호 <강의실>월3,4 / 금3', fileusefg: null,
  }], msgCode: 'success' };
  const items = normalizeSyllabusSearch(body);
  assert.equal(items.length, 1);
  assert.equal(items[0].course_code, '99999');
  assert.equal(items[0].section, '01');
  assert.equal(items[0].college, '테스트대학');
  assert.equal(items[0].department, '테스트학부');
  assert.equal(items[0].has_file, false);
});

test('search resolves current term and preserves subject/professor selection', async () => {
  const { searchSyllabusList } = await import('../src/mportal-client.js');
  const calls: {path:string;body:Record<string,unknown>}[]=[];
  const session = { async mportalPostJson<T>(path:string,body:Record<string,unknown>):Promise<T> {
    calls.push({path,body});
    return (path.endsWith('selectCurYear.ajax') ? {year:[{year:'2099',shtm:'S'}]} : {msgCode:'success',result:[]}) as T;
  }};
  const result=await searchSyllabusList(session,{query:'Synthetic',by:'professor'});
  assert.equal(result.ok,true);
  assert.deepEqual(calls[1].body,{year:'2099',shtm:'S',choice:'prof',searchnm:'Synthetic'});
});
test('portal auth failures are returned without transport details',async()=> {
  const { searchSyllabusList } = await import('../src/mportal-client.js');
  const result=await searchSyllabusList({async mportalPostJson(){throw new Error('private-cookie');}},{year:'2099',term:'S',query:'Synthetic'});
  assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/private-cookie/);
});
