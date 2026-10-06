import { HttpSession } from '../src/http-session.js';
import { resolveDoctorCredentials } from '../src/doctor.js';
import { getEclassPassword } from '../src/secrets.js';

async function main() {
  const credentials = await resolveDoctorCredentials();
  if (!credentials.username) throw new Error('Configured username missing');
  const session = new HttpSession();
  await session.login(credentials.username, () => getEclassPassword(
    credentials.username!, credentials.envPassword, undefined, credentials.plaintextOverride,
  ));
  const settings = await session.html('https://eclass3.cau.ac.kr/profile/settings');
  const warmup = await session.html('https://mportal2.cau.ac.kr/std/usk/sUskSif002/index.do?type=1');
  const term = await session.request('https://mportal2.cau.ac.kr/std/usk/sUskSif002/selectCurYear.ajax', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}',
  }, false);
  let termAvailable = false;
  try { termAvailable = Array.isArray(JSON.parse(term.text).year); } catch { /* report below */ }
  console.log(JSON.stringify({ authenticated_self: await session.authenticated(),
    authenticated_settings: settings.ok && new URL(settings.url).pathname === '/profile/settings',
    portal_status: warmup.status, portal_path: new URL(warmup.url).pathname,
    current_term_available: termAvailable }));
  if (!termAvailable) process.exitCode = 1;
}
main().catch(() => { console.error('HTTP session probe failed.'); process.exitCode = 1; });
