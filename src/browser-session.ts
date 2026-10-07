import { HttpSession, SessionExpiredError } from './http-session.js';
import { createCanvasTokenFromSession, listCanvasTokensFromSession, revokeCanvasTokenFromSession, type SessionTokenCreationResponse } from './canvas-session-tokens.js';
import type { BrowserContext, Response } from 'playwright';
import type { CachedToken, CachedTokenRevocation, CachedTokenV2, ResourceItem } from './types.js';
import { CanvasClient } from './canvas-client.js';
import {
  CANVAS_BASE_URL,
  CANVAS_JSON_ACCEPT,
  CANVAS_TOKEN_LIFETIME_MS,
  canAdoptCachedToken,
  createCanvasTokenPurpose,
  createCachedTokenV2,
  extractCreatedCanvasTokenCandidate,
  isCachedTokenV2,
  parseCachedTokenCredential,
  pendingRevocationsForRotation,
  revokeCanvasToken,
  revocationForCreatedCanvasTokenCompensation,
  sameCachedTokenGeneration,
  sameCachedTokenSnapshot,
  selectCanvasTokenForRecovery,
} from './canvas-token-lifecycle.js';
import { withCanvasTokenLock } from './canvas-token-lock.js';
import type { CanvasTokenLock } from './canvas-token-lock.js';
import { CanvasTokenRevocationLedger } from './canvas-token-revocation-ledger.js';
import { deleteCredential, getCredential, setCredential } from './credential-store.js';
import { redactUrl } from './discovery/redact.js';
import { debugLog } from './secrets.js';
import { fetchModulebuilderViaApi, fetchCourseResourceViaApi } from './learningx-client.js';
import type { LaunchArtifact } from './external-tool-launch.js';
import { downloadOcsDocument, resolveHttpExternalTool, fetchLearningxBoardMaterials, type LearningxBoardLocation } from './http-materials.js';
export { parseLearningxBoardLocation, parseLearningxBoardPostAttachment } from './http-materials.js';

const BASE_URL = CANVAS_BASE_URL;
const KEYCHAIN_SERVICE = 'eclass-mcp';

async function readTokenFromKeychain(username: string): Promise<CachedToken | null> {
  const raw = await getCredential(KEYCHAIN_SERVICE, `token:${username}`);
  return parseCachedTokenCredential(raw);
}

async function writeTokenToKeychain(username: string, cached: CachedToken): Promise<void> {
  await setCredential(
    KEYCHAIN_SERVICE,
    `token:${username}`,
    JSON.stringify(cached),
    { allowFileFallback: false },
  );
}

export function parseCachedSessionCredential(raw: string | null): object | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !('cookies' in parsed) ||
      !Array.isArray(parsed.cookies) ||
      !('origins' in parsed) ||
      !Array.isArray(parsed.origins)
    ) {
      throw new Error('invalid session cache shape');
    }
    return parsed;
  } catch {
    // The credential backend succeeded, so this is isolated cache corruption,
    // not an unavailable secure store. A fresh login may safely replace it.
    debugLog('browser-session', 'Cached browser session is corrupt; ignoring it');
    return null;
  }
}

async function readSessionFromKeychain(username: string): Promise<object | null> {
  const raw = await getCredential(KEYCHAIN_SERVICE, `session:${username}`);
  return parseCachedSessionCredential(raw);
}

async function writeSessionToKeychain(username: string, state: object): Promise<void> {
  await setCredential(
    KEYCHAIN_SERVICE,
    `session:${username}`,
    JSON.stringify(state),
    { allowFileFallback: false },
  );
}

async function deleteSessionFromKeychain(username: string): Promise<void> {
  try {
    await deleteCredential(KEYCHAIN_SERVICE, `session:${username}`);
  } catch {
    // ignore — not present is fine
  }
}

class CanvasTokenCacheChangedError extends Error {
  constructor(readonly latest: CachedToken | null) {
    super('Canvas token cache changed during rotation');
  }
}

export function buildCanvasTokenCompensationRetentionError(
  operationError: unknown,
  ledgerError: unknown,
): Error {
  return new Error(
    'A newly issued Canvas token could not be revoked or recorded because secure ' +
    'credential storage failed. The token may still be live; manually revoke the ' +
    'eclass-mcp token in Canvas profile settings before retrying.',
    {
      cause: new AggregateError(
        [operationError, ledgerError],
        'Token operation and ledger append both failed',
      ),
    },
  );
}

export function buildCanvasTokenRecoveryManualCleanupError(
  operationError: unknown,
  recoveryError: unknown,
): Error {
  return new Error(
    'Canvas token creation may have succeeded, but the exact issued token could not be ' +
    'identified and revoked safely. Manually review Canvas profile settings and revoke ' +
    'the correlated eclass-mcp token before retrying.',
    {
      cause: new AggregateError(
        [operationError, recoveryError],
        'Token creation and exact recovery both failed',
      ),
    },
  );
}

function isSameOriginCanvasResponse(responseUrl: string): boolean {
  if (!responseUrl) return false;
  try {
    return new URL(responseUrl).origin === BASE_URL;
  } catch {
    return false;
  }
}

export function isSsoLoginUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === 'canvas.cau.ac.kr' && url.pathname.startsWith('/xn-sso/')) ||
      (url.hostname === 'eclass3.cau.ac.kr' && url.pathname === '/login') ||
      (url.hostname === 'mportal2.cau.ac.kr' &&
        url.pathname === '/common/auth/newSsoLogin.do')
    );
  } catch {
    return false;
  }
}

export interface EclassAuthProbeResult {
  token_source: 'cache' | 'login';
}

export interface EclassCoursesProbeResult {
  course_count: number;
}

export interface EclassCourseresourceProbeResult {
  course_id: number | null;
  item_count: number;
  skipped: boolean;
  reason?: string;
}

type SessionContextOptions = { acceptDownloads?: boolean };
function normalizeCourseId(raw: unknown): number | null {
  const value = typeof raw === 'number' || typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

const DIAGNOSTIC_URL_PATTERN = /(?:https?|blob:https?):\/\/[^\s|]+/gi;
const DIAGNOSTIC_SECRET_QUERY_PATTERN = /([?&#](?:[^=&#]*(?:token|secret|password|session|cookie|auth|signature|sig|verifier|ticket|sso|saml|assertion|relay|oauth|code|state|jwt|key)[^=&#]*)=)[^&\s|]*/gi;

export function redactBrowserDiagnostic(value: string): string {
  return value
    .replace(DIAGNOSTIC_URL_PATTERN, (url) => redactUrl(url))
    .replace(DIAGNOSTIC_SECRET_QUERY_PATTERN, '$1[REDACTED]');
}

function redactBrowserUrl(rawUrl: string, baseUrl?: string): string {
  if (baseUrl) {
    try {
      return redactUrl(new URL(rawUrl, baseUrl).toString());
    } catch {
      // Fall through to the fail-closed unparseable marker.
    }
  }
  return redactUrl(rawUrl);
}

function sessionRedirectError(rawUrl: string): Error {
  return new Error(`SESSION_REDIRECT:${redactBrowserUrl(rawUrl)}`);
}

export { isStreamingMediaType } from './media-types.js';

export class BrowserSession {
  private client: CanvasClient | null = null;
  // Single-flight lock: shares one HTTP login across parallel callers
  private loginPromise: Promise<CanvasClient> | null = null;
  private playwrightCheckPromise: Promise<void> | null = null;
  private lastPlaywrightCheckAt = 0;
  private lastAuthSource: 'cache' | 'login' | null = null;
  // Single-flight lock for 401-triggered token refresh
  private tokenRefreshPromise: Promise<string> | null = null;
  // Injectable HTTP resource fetcher for tests.
  private courseResourceApiFetcher: typeof fetchCourseResourceViaApi = fetchCourseResourceViaApi;

  /**
   * @param credentialFactory - called only at login time; result goes out of scope
   *   after the HTTP form submission.
   */
  constructor(
    private username: string,
    private credentialFactory: () => Promise<string>,
  ) {}

  /**
   * Returns a CanvasClient with a valid token.
   * Reads token cache first; if missing or expired, uses HTTP SSO
   * to log in and issue a new Canvas API token.
   * Concurrent calls share a single login attempt via loginPromise.
   */
  async getClient(): Promise<CanvasClient> {
    if (this.client) return this.client;
    return this.startLogin();
  }

  private startLogin(rejectedToken?: string): Promise<CanvasClient> {
    if (!this.loginPromise) {
      this.loginPromise = this._doLogin(rejectedToken).catch((err: unknown) => {
        this.loginPromise = null; // allow retry on failure
        throw err;
      });
    }
    return this.loginPromise;
  }

  async ensurePlaywrightReady(): Promise<void> {
    const now = Date.now();
    if (this.lastPlaywrightCheckAt !== 0 && now - this.lastPlaywrightCheckAt < 5 * 60 * 1000) {
      return;
    }

    if (!this.playwrightCheckPromise) {
      this.playwrightCheckPromise = (async () => {
        const { chromium } = await import('playwright');
        let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
        try {
          browser = await chromium.launch({ headless: true });
          this.lastPlaywrightCheckAt = Date.now();
          debugLog('browser-session', `Playwright health check passed (${browser.version() || 'chromium'})`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            'Playwright Chromium 검차 실패: 브라우저를 실행할 수 없습니다.\n' +
            `  원인: ${message}\n` +
            '  해결: pnpm run install:browser',
          );
        } finally {
          await browser?.close().catch(() => undefined);
          this.playwrightCheckPromise = null;
        }
      })();
    }

    return this.playwrightCheckPromise;
  }

  async ensureAuthenticated(): Promise<EclassAuthProbeResult> {
    await this.getClient();
    return {
      token_source: this.lastAuthSource ?? 'login',
    };
  }

  async probeCoursesApi(): Promise<EclassCoursesProbeResult> {
    const client = await this.getClient();
    const response = await client.fetchOne<Array<{ id?: number }>>('/api/v1/courses?enrollment_state=active&per_page=1');
    return {
      course_count: Array.isArray(response) ? response.length : 0,
    };
  }

  async probeCourseresource(): Promise<EclassCourseresourceProbeResult> {
    const client = await this.getClient();
    const courses = await client.fetchOne<Array<{ id: string | number; name?: string }>>('/api/v1/courses?enrollment_state=active&per_page=1');
    const firstCourseId = Array.isArray(courses)
      ? courses.map((course) => normalizeCourseId(course.id)).find((courseId) => courseId !== null) ?? null
      : null;
    if (firstCourseId === null) {
      return {
        course_id: null,
        item_count: 0,
        skipped: true,
        reason: '활성 강의가 없어 courseresource 검차를 건너뜁니다.',
      };
    }

    const items = await this.fetchCourseresources(firstCourseId);
    return {
      course_id: firstCourseId,
      item_count: items.length,
      skipped: false,
    };
  }

  private createCanvasClient(token: string): CanvasClient {
    return new CanvasClient(
      BASE_URL,
      token,
      (rejectedToken) => this.refreshTokenAfterAuthError(rejectedToken),
    );
  }

  /** Called by CanvasClient after a 401. The rejected token is carried into the
   * interprocess critical section so a newer token from another process can be
   * adopted instead of rotated away. */
  private async refreshTokenAfterAuthError(rejectedToken: string): Promise<string> {
    if (!this.tokenRefreshPromise) {
      this.tokenRefreshPromise = (async () => {
        try {
          debugLog('browser-session', 'Canvas returned 401; reconciling the shared token cache');
          this.client = null;
          this.loginPromise = null;
          const client = await this.startLogin(rejectedToken);
          return client.getToken();
        } finally {
          this.tokenRefreshPromise = null;
        }
      })();
    }
    return this.tokenRefreshPromise;
  }

  private async retryPendingTokenRevocations(
    cached: CachedTokenV2,
    ledger: CanvasTokenRevocationLedger,
    lock: CanvasTokenLock,
  ): Promise<CachedTokenV2> {
    await lock.assertOwned();
    // Merge the independent ledger with the legacy embedded queue, excluding
    // both the active id and its hint. The ledger is durably updated before the
    // embedded queue is compacted, so crashes can only cause safe duplicate
    // retries (successful deletion is subsequently observed as 404).
    await ledger.retry(lock, cached, cached.pending_revocations);
    const updated: CachedTokenV2 = { ...cached, pending_revocations: [] };

    if (cached.pending_revocations.length > 0) {
      await lock.assertOwned();
      const current = await readTokenFromKeychain(this.username);
      if (!sameCachedTokenSnapshot(current, cached)) {
        debugLog('browser-session', 'Skipped stale Canvas token revocation queue compaction');
        return current && isCachedTokenV2(current) ? current : cached;
      }
      try {
        await writeTokenToKeychain(this.username, updated);
      } catch {
        // The already-persisted queue is a safe superset and will be retried on
        // the next startup. Never fall back to plaintext just to compact it.
        debugLog('browser-session', 'Could not persist the compacted Canvas token revocation queue');
      }
    }
    return updated;
  }

  private async _doLogin(rejectedToken?: string): Promise<CanvasClient> {
    return withCanvasTokenLock(
      this.username,
      (lock) => this._doLoginWithTokenLock(lock, rejectedToken),
    );
  }

  private async _doLoginWithTokenLock(
    lock: CanvasTokenLock,
    rejectedToken?: string,
  ): Promise<CanvasClient> {
    await lock.assertOwned();
    const revocationLedger = new CanvasTokenRevocationLedger(this.username);
    // Only V2 caches are reusable. Legacy V1 caches must rotate so their old
    // token can be represented by its deterministic five-character hint.
    let cached = await readTokenFromKeychain(this.username);
    // Fail closed on ledger backend/schema errors before issuing another token.
    await revocationLedger.read(lock);
    if (cached && canAdoptCachedToken(cached, rejectedToken)) {
      debugLog(
        'browser-session',
        rejectedToken === undefined
          ? 'Using cached token'
          : 'Adopting a newer Canvas token issued by another process',
      );
      const usableCached = await this.retryPendingTokenRevocations(
        cached,
        revocationLedger,
        lock,
      );
      if (canAdoptCachedToken(usableCached, rejectedToken)) {
        this.lastAuthSource = 'cache';
        this.client = this.createCanvasClient(usableCached.token);
        return this.client;
      }
      cached = usableCached;
    }

    debugLog('browser-session', 'Authenticating via HTTP SSO');
    const context = new HttpSession();
    await context.login(this.username, this.credentialFactory);
    const requestStartedAt = new Date().toISOString();
    const requestedExpiresAt = new Date(
      Date.parse(requestStartedAt) + CANVAS_TOKEN_LIFETIME_MS,
    ).toISOString();
    const purpose = createCanvasTokenPurpose();
    let creation: SessionTokenCreationResponse | null = null;
    let creationCallError: unknown = null;
    try {
      creation = await createCanvasTokenFromSession(
        context,
        requestedExpiresAt,
        purpose,
      );
    } catch (err) {
      // The POST may have committed before fetch/response transport failed.
      // Compensation below reconciles by this attempt's unique purpose.
      creationCallError = err;
    }
    const candidate = creation
      ? extractCreatedCanvasTokenCandidate(creation.body)
      : null;
    let persisted = false;

    try {
      if (!creation) {
        throw new Error('Canvas token creation response was not received', {
          cause: creationCallError,
        });
      }
      if (!isSameOriginCanvasResponse(creation.responseUrl)) {
        throw new Error('Canvas token creation response came from an unexpected origin');
      }
      if (!creation.ok) {
        throw new Error(`Canvas token creation failed (${creation.status})`);
      }
      if (!candidate) {
        throw new Error('Canvas token creation response did not include a visible token');
      }

      let newCached = createCachedTokenV2(candidate, requestStartedAt, requestedExpiresAt);

      // Validate before persisting. Any failure below is compensated by
      // revoking the newly-created token using the authenticated HTTP session.
      const validateRes = await fetch(`${BASE_URL}/api/v1/users/self`, {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${newCached.token}`, Accept: CANVAS_JSON_ACCEPT },
      });
      if (!validateRes.ok) {
        throw new Error(
          `토큰 검증 실패 (${validateRes.status}): 로그인에 문제가 있습니다.\n` +
          '  pnpm run setup 을 다시 실행하세요.',
        );
      }

      await lock.assertOwned();
      const latestCached = await readTokenFromKeychain(this.username);
      if (!sameCachedTokenGeneration(cached, latestCached)) {
        throw new CanvasTokenCacheChangedError(latestCached);
      }
      // A same-generation queue may have been compacted by a process that did
      // not yet implement the lock. Merge from the latest snapshot.
      newCached = {
        ...newCached,
        pending_revocations: pendingRevocationsForRotation(latestCached, newCached),
      };

      // Persist the new token (including the old-token revocation queue)
      // before attempting any old-token deletion. A crash can only leave a
      // retryable queue, never lose the metadata required to revoke it.
      const sessionState = await context.storageState();
      await writeSessionToKeychain(this.username, sessionState);
      await lock.assertOwned();
      const beforeTokenWrite = await readTokenFromKeychain(this.username);
      if (!sameCachedTokenSnapshot(latestCached, beforeTokenWrite)) {
        throw new CanvasTokenCacheChangedError(beforeTokenWrite);
      }
      try {
        await writeTokenToKeychain(this.username, newCached);
        persisted = true;
      } catch (err) {
        // Do not revoke a token that the backend durably stored before
        // reporting a post-write verification/cleanup error.
        const observed = await readTokenFromKeychain(this.username);
        persisted = sameCachedTokenSnapshot(observed, newCached);
        throw err;
      }
      debugLog('browser-session', 'New Canvas token and revocation metadata stored securely');

      newCached = await this.retryPendingTokenRevocations(
        newCached,
        revocationLedger,
        lock,
      );
      this.lastAuthSource = 'login';
      this.client = this.createCanvasClient(newCached.token);
      return this.client;
    } catch (err) {
      let unresolvedCreatedRevocation: CachedTokenRevocation | null = null;
      let compensationRevocation = creation
        ? revocationForCreatedCanvasTokenCompensation(creation, persisted)
        : null;
      const requiresExactRecovery = !persisted &&
        !compensationRevocation &&
        (
          creation === null ||
          !isSameOriginCanvasResponse(creation.responseUrl) ||
          !creation.bodyParsed ||
          creation.ok
        );
      if (requiresExactRecovery) {
        try {
          const listedTokens = await listCanvasTokensFromSession(context);
          const selection = selectCanvasTokenForRecovery(listedTokens, {
            purpose,
            request_started_at: requestStartedAt,
            requested_expires_at: requestedExpiresAt,
            observed_at: new Date().toISOString(),
          });
          if (selection.kind !== 'found') {
            throw new Error(`Exact Canvas token recovery result: ${selection.kind}`);
          }
          compensationRevocation = selection.revocation;
        } catch (recoveryErr) {
          throw buildCanvasTokenRecoveryManualCleanupError(err, recoveryErr);
        }
      }
      if (compensationRevocation) {
        let revoked = await revokeCanvasTokenFromSession(context, compensationRevocation);
        if (
          !revoked &&
          candidate &&
          creation &&
          isSameOriginCanvasResponse(creation.responseUrl)
        ) {
          revoked = await revokeCanvasToken(
            candidate.token,
            compensationRevocation,
          );
        }
        if (!revoked) {
          debugLog('browser-session', 'Could not compensate by revoking the newly-created Canvas token');
          unresolvedCreatedRevocation = compensationRevocation;
        }
      }
      if (unresolvedCreatedRevocation) {
        const activeForSafety = err instanceof CanvasTokenCacheChangedError
          ? err.latest
          : cached;
        try {
          await revocationLedger.append(lock, unresolvedCreatedRevocation, activeForSafety);
        } catch (ledgerErr) {
          throw buildCanvasTokenCompensationRetentionError(err, ledgerErr);
        }
        debugLog('browser-session', 'Retained failed Canvas token compensation in the secure ledger');
      }
      const latest = err instanceof CanvasTokenCacheChangedError
        ? err.latest
        : await readTokenFromKeychain(this.username);
      if (err instanceof CanvasTokenCacheChangedError && latest) {
        if (!canAdoptCachedToken(latest, rejectedToken)) throw err;
        debugLog('browser-session', 'Adopting Canvas token that won a concurrent cache update');
        const adopted = await this.retryPendingTokenRevocations(
          latest,
          revocationLedger,
          lock,
        );
        if (canAdoptCachedToken(adopted, rejectedToken)) {
          this.lastAuthSource = 'cache';
          this.client = this.createCanvasClient(adopted.token);
          return this.client;
        }
      }
      throw err;
    }
  }

  private async refreshHttpSession(lock: CanvasTokenLock): Promise<void> {
    const session = new HttpSession();
    await session.login(this.username, this.credentialFactory);
    await lock.assertOwned();
    await writeSessionToKeychain(this.username, session.storageState());
  }

  private async withAuthenticatedContext<T>(
    label: string,
    options: SessionContextOptions,
    fn: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cachedSessionState: any = await readSessionFromKeychain(this.username) ?? undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({
          locale: 'ko-KR',
          timezoneId: 'Asia/Seoul',
          ...(options.acceptDownloads ? { acceptDownloads: true } : {}),
          ...(cachedSessionState ? { storageState: cachedSessionState } : {}),
        });

        try {
          return await fn(context);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt === 0 && message.startsWith('SESSION_REDIRECT:')) {
            const redirectedUrl = message.slice('SESSION_REDIRECT:'.length);
            debugLog(
              'browser-session',
              `${label} redirected to login, refreshing session: ${redactBrowserUrl(redirectedUrl)}`,
            );
            await withCanvasTokenLock(this.username, async (lock) => {
              await lock.assertOwned();
              await deleteSessionFromKeychain(this.username);
              await this.refreshHttpSession(lock);
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            cachedSessionState = await readSessionFromKeychain(this.username) ?? undefined;
            continue;
          }
          throw err;
        } finally {
          await context.close();
        }
      } finally {
        await browser.close();
      }
    }

    throw new Error(`${label} 세션 재시도 후에도 브라우저 인증을 복구하지 못했습니다.`);
  }

  /** Browser context reserved for assignment submission and its dry-run recorder. */
  async withSubmissionContext<T>(label: string, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
    await this.ensurePlaywrightReady();
    await this.getClient();
    return this.withAuthenticatedContext(label, {}, fn);
  }

  /** Shares and refreshes native HTTP cookies under the account lock. */
  async withHttpSession<T>(fn: (session: HttpSession) => Promise<T>): Promise<T> {
    return withCanvasTokenLock(this.username, async (lock) => {
      let session = new HttpSession(await readSessionFromKeychain(this.username));
      if (!await session.authenticated()) {
        session = new HttpSession();
        await session.login(this.username, this.credentialFactory);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await fn(session);
          await lock.assertOwned();
          await writeSessionToKeychain(this.username, session.storageState());
          return result;
        } catch (error) {
          if (attempt !== 0 || (error as { code?: string } | null)?.code !== 'EXTERNAL_TOOL_SESSION_EXPIRED') throw error;
          session = new HttpSession();
          await session.login(this.username, this.credentialFactory);
        }
      }
      throw new SessionExpiredError();
    });
  }

  /** Authenticated mportal JSON requests share the account's HTTP cookie state. */
  async mportalPostJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!/^\/std\/usk\/sUskSif002\/(selectCurYear|selectList)\.ajax$/.test(path)) throw new Error('Invalid mportal endpoint');
    return withCanvasTokenLock(this.username, async (lock) => {
      let session = new HttpSession(await readSessionFromKeychain(this.username));
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!await session.authenticated()) {
          session = new HttpSession();
          await session.login(this.username, this.credentialFactory);
        }
        const warmup = await session.html('https://mportal2.cau.ac.kr/std/usk/sUskSif002/index.do?type=1');
        if (!warmup.ok || isSsoLoginUrl(warmup.url) || warmup.text.includes('login_user_password')) {
          if (attempt === 0) { session = new HttpSession(); continue; }
          throw new SessionExpiredError();
        }
        const response = await session.request(`https://mportal2.cau.ac.kr${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
        }, false);
        if (response.status === 401 || response.status === 403 || response.status >= 300 && response.status < 400 || response.text.trimStart().startsWith('<')) {
          if (attempt === 0) { session = new HttpSession(); continue; }
          throw new SessionExpiredError();
        }
        if (!response.ok) throw new Error(`mportal request failed (${response.status})`);
        let parsed: T;
        try { parsed = JSON.parse(response.text) as T; } catch { throw new Error('Invalid mportal JSON response'); }
        await lock.assertOwned();
        await writeSessionToKeychain(this.username, session.storageState());
        return parsed;
      }
      throw new SessionExpiredError();
    });
  }

  async submitAssignmentViaUi(
    courseId: number,
    assignmentId: number,
    filePaths: string[],
    comment?: string,
  ): Promise<void> {
    await this.ensurePlaywrightReady();
    await this.getClient();

    return this.withAuthenticatedContext('assignment submission', {}, async (context) => {
      const page = await context.newPage();
      await page.goto(`${BASE_URL}/courses/${courseId}/assignments/${assignmentId}`, { waitUntil: 'networkidle', timeout: 30000 });
      if (isSsoLoginUrl(page.url())) {
          throw sessionRedirectError(page.url());
      }

      const submitLink = page.locator('.submit_assignment_link').first();
      if (await submitLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await submitLink.click();
      }

      const fileInput = page.locator('input[name="attachments[0][uploaded_data]"]').first();
      await fileInput.setInputFiles(filePaths, { timeout: 15000 });

      if (comment?.trim()) {
        const commentBox = page.locator('textarea[name="submission[comment]"]').first();
        if (await commentBox.isVisible({ timeout: 2000 }).catch(() => false)) {
          await commentBox.fill(comment);
        }
      }

      const pledge = page.locator('input[name="turnitin_pledge"]').first();
      if (await pledge.isVisible({ timeout: 2000 }).catch(() => false)) {
        await pledge.check();
      }

      const responsePromise = page.waitForResponse(
        (response: Response) => response.request().method() === 'POST'
          && response.url().includes(`/courses/${courseId}/assignments/${assignmentId}/submissions`),
        { timeout: 30000 },
      );
      // 클릭이 실패하면 responsePromise는 await되지 못한 채 컨텍스트 종료 시
      // TargetClosedError로 reject되어 프로세스를 죽인다 — 미리 핸들러를 붙여둔다.
      responsePromise.catch(() => undefined);
      await page.locator('input[type="submit"][value*="과제 제출"], button:has-text("과제 제출")').first().click();
      const response = await responsePromise;
      if (!response.ok() && ![302, 303].includes(response.status())) {
        throw new Error(`UI submission failed ${response.status()}`);
      }
    });
  }

  async downloadCourseresourceFile(
    courseId: number, resourceId: string, displayName: string, downloadDir: string, viewUrl?: string,
  ): Promise<string> {
    if (!viewUrl) throw new Error(`Resource ${resourceId} has no viewUrl`);
    return this.withHttpSession(session => downloadOcsDocument(courseId, resourceId, displayName, downloadDir, viewUrl, session));
  }

  async fetchLearningxBoardMaterials(courseId: number, board: LearningxBoardLocation): Promise<ResourceItem[]> {
    const client = await this.getClient();
    return this.withHttpSession(session => fetchLearningxBoardMaterials(session, client, courseId, board));
  }

  async resolveExternalToolLaunch(courseId: number, moduleItemUrl: string): Promise<LaunchArtifact> {
    const client = await this.getClient();
    return this.withHttpSession(session => resolveHttpExternalTool(session, client, courseId, moduleItemUrl));
  }

  async fetchModulebuilder(courseId: number): Promise<ResourceItem[]> {
    return fetchModulebuilderViaApi(await this.getClient(), courseId);
  }

  async fetchCourseresources(courseId: number): Promise<ResourceItem[]> {
    return this.courseResourceApiFetcher(await this.getClient(), courseId, this.username);
  }
}
