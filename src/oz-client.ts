import { Reader, parseHeader, loginRequest, dataRequest, parseDataModule } from './oz-protocol.js';
import { mapOzDatasetsToSyllabusDocument } from './tools/syllabus/oz-datasets.js';

export interface OzSyllabusInput {
  year: string; term: string; sbjtno1: string; clssno1: string; campcd: string; sust: string;
}
export class OzSyllabusError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
async function post(body: Buffer, transport: typeof fetch): Promise<Buffer> {
  try {
    const response = await transport('https://rpt80.cau.ac.kr/oz80/server', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error('OZ HTTP request failed');
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) throw new Error('Oversized OZ response');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch {
    throw new OzSyllabusError('SYLLABUS_TRANSPORT_FAILED', '강의계획서 서버 통신에 실패했습니다. 잠시 후 다시 시도하세요.');
  }
}
function protocol<T>(read: () => T): T {
  try { return read(); } catch {
    throw new OzSyllabusError('SYLLABUS_PROTOCOL_FAILED', '강의계획서 데이터 형식을 해석하지 못했습니다.');
  }
}
export async function fetchOzSyllabus(input: OzSyllabusInput, transport: typeof fetch = fetch) {
  const campus = input.campcd, sust = input.sust;
  if (![input.year, input.term, input.sbjtno1, input.clssno1, campus, sust].every(v => typeof v === 'string') || !/^\d{4}$/.test(input.year) || !/^[12SW]$/.test(input.term) || !/^[12]$/.test(campus)
      || !/^[A-Za-z0-9]+$/.test(sust) || !/^\d+$/.test(input.sbjtno1) || !/^\d+$/.test(input.clssno1)) {
    throw new OzSyllabusError('SYLLABUS_INVALID_INPUT', '검색 결과의 학기·캠퍼스·학과·학수번호·분반을 전달하세요.');
  }
  const loginBytes = await post(loginRequest(), transport);
  const login = protocol(() => parseHeader(new Reader(loginBytes)));
  if (login.name !== 'oz.framework.cp.message.repository.OZRepositoryResponseUserLogin'
    || !login.fields.s || login.fields.s === '-1905') throw new OzSyllabusError('SYLLABUS_PROTOCOL_FAILED', '강의계획서 세션 응답이 올바르지 않습니다.');
  const dataBytes = await post(dataRequest(login.fields.s, {
    year: input.year, shtm: input.term, camp_cd: campus, sust,
    sbjt_no: input.sbjtno1, clss_no: input.clssno1, emp_no: '',
  }), transport);
  const decoded = protocol(() => parseDataModule(dataBytes));
  const b = decoded.datasets.ds_basicinfo;
  if (!b?.length) throw new OzSyllabusError('SYLLABUS_NOT_FOUND', '요청한 강의계획서가 없습니다.');
  if (b.length !== 1 || b[0].YEAR !== input.year || b[0].SHTM !== input.term || b[0].CAMPCD !== campus
      || b[0].SUST !== sust || b[0].SBJTNO !== input.sbjtno1 || b[0].CLSSNO !== input.clssno1) {
    throw new OzSyllabusError('SYLLABUS_IDENTITY_MISMATCH', '강의계획서 응답이 요청한 과목과 일치하지 않습니다.');
  }
  try { return mapOzDatasetsToSyllabusDocument(decoded.datasets); } catch {
    throw new OzSyllabusError('SYLLABUS_MAPPING_FAILED', '강의계획서 데이터를 구조화하지 못했습니다.');
  }
}
