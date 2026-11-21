import path from 'node:path';
import { openCodeDatabaseEnv } from './executable.js';

export const MINIMUM_OPENCODE_V2_VERSION = '2.0.28';

export function openCodeV2DataHome(engineDir: string, accountDataHome?: string): string {
  return path.join(accountDataHome ?? engineDir, 'v2-data');
}

export function openCodeV2Env(parent: NodeJS.ProcessEnv, dataHome: string): NodeJS.ProcessEnv {
  return { ...openCodeDatabaseEnv(parent, dataHome), OPENCODE_DB: 'opencode.db' };
}

export function openCodeV2LoginCommand(executable: string, dataHome: string): string {
  if (process.platform === 'win32') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return `Remove-Item Env:OPENCODE_DATA_DIR -ErrorAction SilentlyContinue; $env:XDG_DATA_HOME = ${quote(dataHome)}; $env:OPENCODE_DB = 'opencode.db'; & ${quote(executable)} --standalone auth login`;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `env -u OPENCODE_DATA_DIR XDG_DATA_HOME=${quote(dataHome)} OPENCODE_DB=opencode.db ${quote(executable)} --standalone auth login`;
}
