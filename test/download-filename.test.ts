import { HttpSession } from '../src/http-session.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { BrowserSession } from '../src/browser-session.js';
import { downloadFileToDisk } from '../src/tools/download-file.js';

const cases = [
  ...['main.py', 'main.c', 'main.cpp', 'main.PY', 'data.myformat', 'archive.7z'].map((name) => ({
    name, headers: { 'content-type': 'text/plain' }, expected: name,
  })),
  {
    name: 'main.py',
    headers: { 'content-disposition': 'attachment; filename="download.txt"', 'content-type': 'text/plain' },
    expected: 'main.py',
  },
  {
    name: 'source',
    headers: { 'content-disposition': 'attachment; filename="main.py"', 'content-type': 'text/plain' },
    expected: 'source.py',
  },
  { name: 'algorithm_02.2', headers: { 'content-type': 'application/pdf' }, expected: 'algorithm_02.2.pdf' },
  {
    name: 'algorithm_02.2_divide',
    headers: { 'content-disposition': 'attachment; filename="slides.pdf"', 'content-type': 'application/octet-stream' },
    expected: 'algorithm_02.2_divide.pdf',
  },
  { name: '강의자료', headers: { 'content-type': 'application/pdf' }, expected: '강의자료.pdf' },
  { name: 'algorithm_02.2_divide', headers: { 'content-type': 'application/pdf' }, expected: 'algorithm_02.2_divide.pdf' },
  { name: '강의자료.pdf', headers: { 'content-type': 'application/pdf' }, expected: '강의자료.pdf' },
  { name: '강의자료.PDF', headers: { 'content-type': 'application/pdf' }, expected: '강의자료.PDF' },
  { name: '강의자료.pptx', headers: { 'content-type': 'application/pdf' }, expected: '강의자료.pptx' },
  { name: '강의자료.hwp', headers: { 'content-type': 'application/octet-stream' }, expected: '강의자료.hwp' },
  { name: '강의자료', headers: {}, expected: '강의자료' },
  { name: 'algorithm_02.2_divide', headers: { 'content-type': 'application/octet-stream' }, expected: 'algorithm_02.2_divide' },
  {
    name: '강의자료',
    headers: { 'content-disposition': 'attachment; filename="slides.pptx"', 'content-type': 'application/octet-stream' },
    expected: '강의자료.pptx',
  },
  {
    name: '강의자료',
    headers: { 'content-disposition': "attachment; filename*=UTF-8''%EA%B0%95%EC%9D%98.pdf", 'content-type': 'application/octet-stream' },
    expected: '강의자료.pdf',
  },
  {
    name: '강의자료',
    headers: { 'content-disposition': 'attachment; filename="algorithm_02.2_divide"', 'content-type': 'application/pdf; charset=binary' },
    expected: '강의자료.pdf',
  },
];

for (const route of ['direct', 'OCS'] as const) {
  for (const [index, { name, headers, expected }] of cases.entries()) {
    test(`${route} saves ${name} as ${expected} (case ${index + 1})`, async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-filename-'));
      const bytes = Buffer.from('%PDF-1.7\nfixture');
      const responseHeaders: Record<string, string> = { ...headers };
      const originalFetch = globalThis.fetch;
      const originalDir = process.env.ECLASS_DOWNLOAD_DIR;

      try {
        let localPath: string;
        if (route === 'direct') {
          process.env.ECLASS_DOWNLOAD_DIR = dir;
          globalThis.fetch = async () => new Response(bytes, { headers: responseHeaders });
          const result = await downloadFileToDisk(1, 'https://eclass3.cau.ac.kr/files/1/download', name, 'test-token');
          localPath = result.local_path;
        } else {
          const viewerUrl = 'https://ocs.cau.ac.kr/em/fixture';
          globalThis.fetch = async (input) => {
            const url = String(input);
            if (url.includes('/content.php?')) return new Response(`<content><content_id>fixture</content_id><content_type>sharedocs</content_type><content_download_uri>/index.php?module=xn_media_content2013&amp;act=dispXn_media_content2013DownloadWebFile&amp;content_id=fixture</content_download_uri></content>`);
            assert.ok(url.startsWith('https://ocs.cau.ac.kr/index.php?'));
            return new Response(bytes, { headers: responseHeaders });
          };
          const session = new BrowserSession('tester', async () => { throw new Error('Unexpected login'); });
          Object.assign(session, { withHttpSession: async (fn: (http: HttpSession) => Promise<string>) => fn(new HttpSession()), ensurePlaywrightReady: async () => { throw new Error('Unexpected browser launch'); } });
          localPath = await session.downloadCourseresourceFile(1, 'resource', name, dir, viewerUrl);
        }

        assert.equal(path.basename(localPath), expected);
        assert.deepEqual(await fs.readFile(localPath), bytes);
      } finally {
        globalThis.fetch = originalFetch;
        if (originalDir === undefined) delete process.env.ECLASS_DOWNLOAD_DIR;
        else process.env.ECLASS_DOWNLOAD_DIR = originalDir;
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
}
