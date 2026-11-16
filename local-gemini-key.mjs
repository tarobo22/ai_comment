import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const decrypt = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
  "$keyPath = Join-Path $env:LOCALAPPDATA 'UnmyeongwonStudio\\gemini-api-key.dpapi'",
  '$secret = ConvertTo-SecureString -String ([IO.File]::ReadAllText($keyPath).Trim())',
  "try { [Console]::Write([System.Net.NetworkCredential]::new('', $secret).Password) } finally { $secret.Dispose() }",
].join('; ');

export async function loadLocalGeminiKey() {
  const { GEMINI_API_KEY, LOCALAPPDATA, SystemRoot } = process.env;
  if (GEMINI_API_KEY?.trim() || process.platform !== 'win32' || !LOCALAPPDATA || !SystemRoot) return;
  try {
    await access(join(LOCALAPPDATA, 'UnmyeongwonStudio', 'gemini-api-key.dpapi'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const powershell = join(SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', decrypt], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4096,
  });
  const key = stdout.trim();
  if (!key) throw new Error('Empty protected Gemini key');
  return key;
}
