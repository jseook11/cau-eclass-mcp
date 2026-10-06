import { HttpSession, htmlAttributes, parseHtmlForm, SessionExpiredError } from './http-session.js';
import { CANVAS_BASE_URL, CANVAS_JSON_ACCEPT, revocationIdentifier } from './canvas-token-lifecycle.js';
import type { CachedTokenRevocation } from './types.js';

export interface SessionTokenCreationResponse {
  ok: boolean; status: number; responseUrl: string; body: unknown; bodyParsed: boolean;
}
async function settings(session: HttpSession) {
  const response = await session.html(`${CANVAS_BASE_URL}/profile/settings`);
  if (!response.ok || response.url !== `${CANVAS_BASE_URL}/profile/settings` || response.text.includes('login_user_password')) throw new SessionExpiredError();
  return response;
}
export async function createCanvasTokenFromSession(session: HttpSession, expiresAt: string, purpose: string): Promise<SessionTokenCreationResponse> {
  const page = await settings(session);
  const form = parseHtmlForm(page.text, f => new URL(f.action, page.url).pathname === '/profile/tokens');
  const action = new URL(form.action, page.url);
  if (action.origin !== CANVAS_BASE_URL || action.pathname !== '/profile/tokens') throw new Error('Invalid Canvas token form action');
  const csrf = form.fields.get('authenticity_token')?.trim();
  if (!csrf) throw new Error('Canvas token form missing authenticity token');
  const body = new URLSearchParams({ authenticity_token: csrf, 'access_token[purpose]': purpose, 'access_token[expires_at]': expiresAt });
  const response = await session.request(action.href, { method: 'POST', headers: {
    Accept: CANVAS_JSON_ACCEPT, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  }, body: body.toString() }, false);
  let parsed: unknown = null; let bodyParsed = false;
  try { parsed = JSON.parse(response.text); bodyParsed = true; } catch { /* exact recovery handles unparseable creation response */ }
  return { ok: response.ok, status: response.status, responseUrl: response.url, body: parsed, bodyParsed };
}
export async function listCanvasTokensFromSession(session: HttpSession): Promise<unknown> {
  const response = await session.request(`${CANVAS_BASE_URL}/api/v1/users/self/user_generated_tokens?per_page=100`, { headers: { Accept: CANVAS_JSON_ACCEPT } }, false);
  if (!response.ok) throw new Error(`Canvas token recovery listing failed (${response.status})`);
  return JSON.parse(response.text) as unknown;
}
export async function revokeCanvasTokenFromSession(session: HttpSession, revocation: CachedTokenRevocation): Promise<boolean> {
  const identifier = revocationIdentifier(revocation); if (!identifier) return false;
  try {
    const page = await settings(session);
    const meta = [...page.text.matchAll(/<meta\b[^>]*>/gi)].map(m => htmlAttributes(m[0])).find(m => m.name === 'csrf-token');
    const response = await session.request(`${CANVAS_BASE_URL}/api/v1/users/self/tokens/${encodeURIComponent(identifier)}`, {
      method: 'DELETE', headers: { Accept: CANVAS_JSON_ACCEPT, ...(meta?.content ? { 'X-CSRF-Token': meta.content } : {}) },
    }, false);
    return response.ok || response.status === 404;
  } catch { return false; }
}
