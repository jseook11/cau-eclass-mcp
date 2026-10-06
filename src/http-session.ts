import { constants, privateDecrypt } from 'node:crypto';

const BASE = 'https://eclass3.cau.ac.kr';
const HOSTS = new Set(['eclass3.cau.ac.kr', 'canvas.cau.ac.kr', 'mportal2.cau.ac.kr', 'ocs.cau.ac.kr']);
const MAX_BODY = 20 * 1024 * 1024;
export interface SessionCookie {
  name: string; value: string; domain: string; path: string; expires: number;
  httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
}
export interface HttpSessionState { cookies: SessionCookie[]; origins: [] }
export interface HttpResult { url: string; status: number; ok: boolean; headers: Headers; text: string }
export class SessionExpiredError extends Error {
  constructor() { super('HTTP authentication session expired'); }
}
export class SsoPageChangedError extends Error {
  readonly code = 'SSO_PAGE_CHANGED';
  constructor() { super('SSO_PAGE_CHANGED: 학교 인증 페이지의 형식을 확인할 수 없습니다.'); }
}
function ssoPage<T>(parse: () => T): T {
  try { return parse(); } catch { throw new SsoPageChangedError(); }
}
function loginFormAction(html: string): string {
  // Support known JS action assignment and ordinary HTML form attributes.
  const assigned = /document\s*\.\s*forms\s*\[\s*(['"])form1\1\s*\]\s*\.\s*action\s*=\s*(['"])([^'"]+)\2/.exec(html);
  const inputs = [...html.matchAll(/<input\b[^>]*>/gi)].map(m => htmlAttributes(m[0]));
  if (!inputs.some(a => a.name === 'login_user_password')) throw new SsoPageChangedError();
  return assigned?.[3] ?? parseHtmlForm(html, f => f.fields.has('login_user_password')).action;
}
function allowed(raw: string, base = BASE): URL {
  const u = new URL(raw, base);
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname) || u.port || u.username || u.password) {
    throw new Error('HTTP session destination outside allowlist');
  }
  return u;
}
/** Uses the same destination boundary as authenticated HTTP requests. */
export function isAllowedHttpDestination(raw: string, base = BASE): boolean {
  try { allowed(raw, base); return true; } catch { return false; }
}
function validDomain(domain: string): boolean {
  return domain === '.cau.ac.kr' || HOSTS.has(domain.replace(/^\./, ''));
}
function domainMatches(host: string, domain: string): boolean {
  return domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
}
function pathMatches(path: string, cookiePath: string): boolean {
  return path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));
}
export class HttpSession {
  private cookies: SessionCookie[] = [];
  constructor(state?: object | null, private transport: typeof fetch = fetch) {
    const list = (state as Partial<HttpSessionState> | undefined)?.cookies;
    if (Array.isArray(list)) this.cookies = list.filter(c => c && typeof c.name === 'string'
      && /^[!#$%&'*+.^_`|~\w-]+$/.test(c.name) && typeof c.value === 'string' && !/[;\r\n]/.test(c.value)
      && typeof c.domain === 'string' && validDomain(c.domain) && typeof c.path === 'string'
      && c.path.startsWith('/') && Number.isFinite(c.expires)).map(c => ({ ...c }));
  }
  storageState(): HttpSessionState {
    return { cookies: this.cookies.filter(c => c.expires < 0 || c.expires > Date.now() / 1000).map(c => ({ ...c })), origins: [] };
  }
  cookieValue(name: string, rawUrl: string): string | undefined {
    const u = allowed(rawUrl);
    return this.storageState().cookies.find(c => c.name === name && domainMatches(u.hostname, c.domain) && pathMatches(u.pathname, c.path))?.value;
  }
  private absorb(headers: Headers, u: URL): void {
    for (const raw of headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const name = pair.slice(0, idx).trim(), value = pair.slice(idx + 1).trim();
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[;\r\n]/.test(value)) continue;
      const properties = new Map(attrs.map(a => {
        const i = a.indexOf('=');
        return i < 0 ? [a.trim().toLowerCase(), ''] : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()];
      }));
      const rawDomain = properties.get('domain')?.toLowerCase().replace(/^\./, '');
      const domain = rawDomain ? `.${rawDomain}` : u.hostname;
      if (rawDomain && rawDomain !== 'cau.ac.kr' && rawDomain !== u.hostname) continue;
      if (!domainMatches(u.hostname, domain)) continue;
      const defaultPath = u.pathname.slice(0, u.pathname.lastIndexOf('/')) || '/';
      const path = properties.get('path')?.startsWith('/') ? properties.get('path')! : defaultPath;
      let expires = -1;
      const expiry = properties.get('expires');
      if (expiry && Number.isFinite(Date.parse(expiry))) expires = Date.parse(expiry) / 1000;
      const age = properties.get('max-age');
      if (age !== undefined && /^-?\d+$/.test(age)) expires = Date.now() / 1000 + Number(age);
      this.cookies = this.cookies.filter(c => !(c.name === name && c.domain === domain && c.path === path));
      if (expires !== -1 && expires <= Date.now() / 1000) continue;
      const sameSite = properties.get('samesite')?.toLowerCase();
      this.cookies.push({ name, value, domain, path, expires, httpOnly: properties.has('httponly'),
        secure: properties.has('secure'), sameSite: sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax' });
    }
  }
  async open(rawUrl: string, init: RequestInit = {}, follow = true): Promise<{ url: string; response: Response }> {
    let u = allowed(rawUrl), method = init.method ?? 'GET', body = init.body;
    const headers = new Headers(init.headers);
    headers.delete('cookie');
    for (let step = 0; step < 12; step++) {
      const sent = new Headers(headers);
      const cookie = this.storageState().cookies.filter(c => domainMatches(u.hostname, c.domain) && pathMatches(u.pathname, c.path))
        .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
      if (cookie) sent.set('Cookie', cookie);
      let response: Response;
      try { response = await this.transport(u.href, { ...init, method, body, headers: sent, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30_000) }); }
      catch { throw new Error('HTTP session transport failed'); }
      this.absorb(response.headers, u);
      const location = response.headers.get('location');
      if (follow && [301,302,303,307,308].includes(response.status) && location) {
        await response.body?.cancel();
        const next = allowed(location, u.href);
        if (next.origin !== u.origin) {
          headers.delete('Authorization'); headers.delete('Origin'); headers.delete('Referer');
          if (method !== 'GET' && method !== 'HEAD' && [307,308].includes(response.status)) throw new Error('Cross-origin HTTP form redirect rejected');
        }
        if (response.status === 303 || ([301,302].includes(response.status) && method === 'POST')) {
          method = 'GET'; body = undefined; headers.delete('Content-Type');
        }
        u = next; continue;
      }
      return { url: u.href, response };
    }
    throw new Error('HTTP session redirect limit reached');
  }
  async request(rawUrl: string, init: RequestInit = {}, follow = true): Promise<HttpResult> {
    const { url, response } = await this.open(rawUrl, init, follow);
    const chunks: Uint8Array[] = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error('Oversized HTTP session response');
      chunks.push(chunk);
    }
    return { url, status: response.status, ok: response.ok, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') };
  }
  async html(url: string): Promise<HttpResult> {
    let result = await this.request(url, { headers: { Accept: 'text/html' } });
    for (let i = 0; i < 5; i++) {
      if (!/\.submit\s*\(/.test(result.text) || /login_user_password/.test(result.text)) return result;
      let form: HtmlForm;
      try {
        form = parseHtmlForm(result.text, f => /^\/(?:common\/auth\/|xn-sso\/)/.test(new URL(f.action, result.url).pathname));
      } catch { return result; }
      result = await this.submit(form, result.url);
    }
    throw new Error('HTTP session form limit reached');
  }
  async submit(form: HtmlForm, source: string): Promise<HttpResult> {
    const action = allowed(form.action, source);
    if (form.method === 'GET') { for (const [k,v] of form.fields) action.searchParams.append(k,v); }
    return this.request(action.href, { method: form.method,
      headers: { Accept: 'text/html', Referer: source, Origin: new URL(source).origin,
        ...(form.method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form.method === 'POST' ? { body: form.fields.toString() } : {}) });
  }
  async login(username: string, password: () => Promise<string>): Promise<void> {
    let result = await this.html(BASE);
    const action = ssoPage(() => loginFormAction(result.text));
    const csrf = this.cookieValue('xn_sso_csrf_token_for_this_login', 'https://canvas.cau.ac.kr/xn-sso/gw-cb.php');
    ssoPage(() => {
      if (!csrf) throw new SsoPageChangedError();
      const loginAction = allowed(action, result.url);
      if (loginAction.origin !== 'https://canvas.cau.ac.kr' || loginAction.pathname !== '/xn-sso/gw-cb.php') throw new SsoPageChangedError();
    });
    const fields = new URLSearchParams({ csrf_token: csrf!, login_user_id: username, login_user_password: await password() });
    try { result = await this.submit({ action, method: 'POST', fields }, result.url); }
    finally { fields.delete('login_user_password'); }
    const cryption = /window\s*\.\s*loginCryption\s*\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/.exec(result.text);
    if (!cryption) throw new SsoPageChangedError();
    const stringValue = (literal: string): string => literal.startsWith('"') ? JSON.parse(literal) as string
      : literal.slice(1,-1).replace(/\\n/g,'\n').replace(/\\r/g,'\r').replace(/\\'/g,"'").replace(/\\\\/g,'\\');
    const rawKey = ssoPage(() => stringValue(cryption[2])).replace(/\\n/g,'\n').replace(/\\r/g,'\r');
    const pem = /-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(rawKey);
    const key = pem ? `-----BEGIN ${pem[1]}-----\n${pem[2].replace(/\s/g,'')}\n-----END ${pem[1]}-----`
      : `-----BEGIN RSA PRIVATE KEY-----\n${rawKey}\n-----END RSA PRIVATE KEY-----`;
    const block = ssoPage(() => privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, Buffer.from(stringValue(cryption[1]), 'base64')));
    let form: HtmlForm | undefined;
    try {
      form = ssoPage(() => parseHtmlForm(result.text, f => f.fields.has('pseudonym_session[password]')));
      const target = ssoPage(() => allowed(form!.action, result.url));
      if (target.origin !== BASE || target.pathname !== '/login/canvas' || form.method !== 'POST') throw new SsoPageChangedError();
      const separator = block.indexOf(0,2);
      if (block[0] !== 0 || block[1] !== 2 || separator < 10) throw new SsoPageChangedError();
      form.fields.set('pseudonym_session[password]', block.subarray(separator+1).toString('utf8'));
      await this.submit(form, result.url);
    } finally { block.fill(0); form?.fields.delete('pseudonym_session[password]'); }
    if (!await this.authenticated()) throw new Error('SSO authentication failed');
  }
  async authenticated(): Promise<boolean> {
    const result = await this.request(`${BASE}/api/v1/users/self`, { headers: { Accept: 'application/json' } }, false);
    try { const user = JSON.parse(result.text); return result.ok && Boolean(user.id) && typeof user.name === 'string'; }
    catch { return false; }
  }
}
export interface HtmlForm { action: string; method: 'GET' | 'POST'; fields: URLSearchParams }
export function htmlAttributes(tag: string): Record<string,string> {
  const attrs: Record<string,string> = Object.create(null);
  const decode = (s: string) => s.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string,string> = { '&amp;':'&', '&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>' };
    if (named[entity]) return named[entity];
    if (!entity.startsWith('&#')) return entity;
    const n = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3,-1),16) : Number(entity.slice(2,-1));
    return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity;
  });
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3]);
  return attrs;
}
export function parseHtmlForm(html: string, predicate: (form: HtmlForm) => boolean = () => true): HtmlForm {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form\s*>/gi)) {
    const attrs = htmlAttributes(match[1]);
    const fields = new URLSearchParams();
    for (const input of match[2].matchAll(/<input\b[^>]*>/gi)) {
      const a = htmlAttributes(input[0]); if (a.name) fields.append(a.name, a.value ?? '');
    }
    const form: HtmlForm = { action: attrs.action ?? '', method: attrs.method?.toLowerCase() === 'post' ? 'POST' : 'GET', fields };
    if (predicate(form)) return form;
  }
  throw new Error('HTTP form unavailable');
}
