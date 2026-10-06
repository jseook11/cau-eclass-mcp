// Read-only login proof: HTTP requests only, no browser launch or token creation.
// Credentials and cookies stay in memory; output contains no secret values.
import { request, type APIRequestContext, type APIResponse } from 'playwright';
import { resolveDoctorCredentials } from '../src/doctor.js';
import { getEclassPassword } from '../src/secrets.js';
import { parseLtiForm } from '../src/learningx-client.js';
import { constants, privateDecrypt } from 'node:crypto';

const BASE = 'https://eclass3.cau.ac.kr';
const HOSTS = new Set(['eclass3.cau.ac.kr', 'canvas.cau.ac.kr']);

function allowed(raw: string, base = BASE): string {
  const url = new URL(raw, base);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) {
    throw new Error('SSO destination outside the probe allowlist');
  }
  return url.href;
}

function trace(response: APIResponse): void {
  const url = new URL(response.url());
  const cookieNames = response.headersArray()
    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
    .map(({ value }) => value.slice(0, value.indexOf('=')));
  console.log(JSON.stringify({
    method_response: response.status(), host: url.hostname, path: url.pathname,
    set_cookie_names: cookieNames,
  }));
}

async function follow(
  context: APIRequestContext, url: string, method = 'GET', data?: string,
  referer?: string,
): Promise<{ response: APIResponse; html: string }> {
  for (let step = 0; step < 12; step++) {
    const headers: Record<string, string> = { Accept: 'text/html' };
    if (referer) headers.Referer = referer;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Origin = new URL(referer ?? url).origin;
    }
    const response = await context.fetch(allowed(url), {
      method, data, headers, maxRedirects: 0, timeout: 20000,
    });
    trace(response);
    const location = response.headers().location;
    if (response.status() >= 300 && response.status() < 400 && location) {
      referer = url;
      url = allowed(location, url);
      if (response.status() === 303 || ((response.status() === 301 || response.status() === 302) && method === 'POST')) {
        method = 'GET'; data = undefined;
      }
      continue;
    }
    return { response, html: await response.text() };
  }
  throw new Error('SSO redirect limit reached');
}

async function main(): Promise<void> {
  const credentials = await resolveDoctorCredentials();
  if (!credentials.username) throw new Error('Configured username missing');
  // APIRequestContext implements HTTP and a cookie jar. No Chromium is started.
  const context = await request.newContext();
  try {
    let result = await follow(context, BASE);
    const action = /document\.forms\["form1"\]\.action\s*=\s*"([^"]+)"/.exec(result.html)?.[1];
    if (!action || !result.html.includes('login_user_password')) {
      throw new Error('Expected OnLogon form missing');
    }
    const cookies = (await context.storageState()).cookies;
    const csrf = cookies.find((cookie) => cookie.name === 'xn_sso_csrf_token_for_this_login');
    if (!csrf) throw new Error('Initial login CSRF cookie missing');
    const fields = new URLSearchParams({
      csrf_token: csrf.value,
      login_user_id: credentials.username,
      login_user_password: await getEclassPassword(
        credentials.username, credentials.envPassword, undefined, credentials.plaintextOverride,
      ),
    });
    result = await follow(context, allowed(action, result.response.url()), 'POST', fields.toString(), result.response.url());
    fields.delete('login_user_password');
    // login-cryption.js uses JSEncrypt.decrypt then submits login_form.
    // Parse only the two string arguments; never evaluate remote JavaScript.
    const cryption = /window\.loginCryption\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/.exec(result.html);
    if (cryption) {
      const stringValue = (literal: string): string => literal.startsWith('"')
        ? JSON.parse(literal) as string
        : literal.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      const ciphertext = stringValue(cryption[1]);
      const rawKey = stringValue(cryption[2]).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
      const pem = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(rawKey);
      const key = pem
        ? `-----BEGIN ${pem[1]}-----\n${pem[2].replace(/\s/g, '')}\n-----END ${pem[1]}-----`
        : `-----BEGIN RSA PRIVATE KEY-----\n${rawKey}\n-----END RSA PRIVATE KEY-----`;
      // Node's implicit-rejection restrictions disallow legacy PKCS1 decrypt;
      // decode the trusted server's PKCS#1 v1.5 block locally instead.
      const block = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, Buffer.from(ciphertext, 'base64'));
      const separator = block.indexOf(0, 2);
      if (block[0] !== 0 || block[1] !== 2 || separator < 10) throw new Error('Invalid SSO RSA block');
      const form = parseLtiForm(result.html);
      form.fields.set('pseudonym_session[password]', block.subarray(separator + 1).toString('utf8'));
      result = await follow(context, allowed(form.action, result.response.url()), 'POST', form.fields.toString(), result.response.url());
      form.fields.delete('pseudonym_session[password]');
      block.fill(0);
    }

    // Follow explicit SSO auto-submit forms only; never execute returned scripts.
    for (let step = 0; step < 5 && /<form\b/i.test(result.html) && !result.html.includes('login_user_password'); step++) {
      if (!/\.submit\s*\(/.test(result.html)) break;
      const form = parseLtiForm(result.html);
      const method = /<form\b[^>]*method\s*=\s*["']post["']/i.test(result.html) ? 'POST' : 'GET';
      const destination = new URL(allowed(form.action, result.response.url()));
      if (method === 'GET') destination.search = form.fields.toString();
      result = await follow(context, destination.href, method, method === 'POST' ? form.fields.toString() : undefined, result.response.url());
    }
    const self = await context.get(`${BASE}/api/v1/users/self`, {
      headers: { Accept: 'application/json' }, maxRedirects: 0,
    });
    let identityMatches: boolean | null = null;
    let authenticatedSelf = false;
    if (self.ok()) {
      const user = await self.json();
      authenticatedSelf = Boolean(user.id) && typeof user.name === 'string';
      const identifiers = [user.login_id, user.sis_user_id].filter((value) => typeof value === 'string');
      if (identifiers.length > 0) identityMatches = identifiers.includes(credentials.username);
    }
    const settings = await follow(context, `${BASE}/profile/settings`);
    const authenticatedSettings = settings.response.ok()
      && new URL(settings.response.url()).pathname === '/profile/settings'
      && !settings.html.includes('login_user_password')
      && /access_tokens|사용자 설정|settings|설정/i.test(settings.html);
    console.log(JSON.stringify({
      browser_launched: false, existing_session_loaded: false,
      api_self_status: self.status(), authenticated_self: authenticatedSelf,
      identity_matches: identityMatches,
      authenticated_settings: authenticatedSettings,
      cookie_names: [...new Set((await context.storageState()).cookies.map((cookie) => cookie.name))],
    }));
    if (!authenticatedSelf || identityMatches === false || !authenticatedSettings) process.exitCode = 1;
  } finally {
    await context.dispose();
  }
}

main().catch((error: unknown) => {
  // Do not print exception text: remote errors can contain credential-bearing URLs.
  console.error('HTTP login probe failed; no secret details printed.');
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^ERR_[A-Z0-9_]+$/.test(code)) console.error(code);
  process.exitCode = 1;
});
