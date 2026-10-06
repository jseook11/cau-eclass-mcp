import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { BrowserSession } from './browser-session.js';
import { ExamCache } from './exam-cache.js';
import { FileCache } from './file-cache.js';
import { sanitizeDebug } from './errors.js';
import { getEclassPassword, getSecretEnvWarning } from './secrets.js';
import { createEclassServer } from './server.js';

function installProcessSafetyNet(): void {
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`[eclass-mcp] Unhandled rejection: ${sanitizeDebug(message)}\n`);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[eclass-mcp] Uncaught exception: ${sanitizeDebug(err.message)}\n`);
  });
}

function createRuntimeContext(username: string): {
  session: BrowserSession;
  fileCache: FileCache;
  examCache: ExamCache;
} {
  const credentialFactory = (): Promise<string> => getEclassPassword(username);
  return {
    session: new BrowserSession(username, credentialFactory),
    fileCache: new FileCache(),
    examCache: new ExamCache(),
  };
}

async function main(): Promise<void> {
  installProcessSafetyNet();

  const username = process.env.ECLASS_USERNAME;
  if (!username) {
    process.stderr.write(
      '[eclass-mcp] ERROR: ECLASS_USERNAME이 설정되지 않았습니다.\n' +
      '  eclass MCP 설정을 위해 다음을 실행하세요:\n' +
      '  pnpm run setup\n',
    );
    process.exit(1);
  }

  if (process.env.ECLASS_PASSWORD) {
    process.stderr.write(getSecretEnvWarning('ECLASS_PASSWORD', '비밀번호') ?? '');
  }

  const context = createRuntimeContext(username);
  const server = createEclassServer({ username, ...context });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[eclass-mcp] Server running on stdio\n');
}

await main();
