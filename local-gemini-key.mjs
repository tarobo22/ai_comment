import { execFile } from 'node:child_process';
import { access, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const decrypt = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
  "$keyPath = Join-Path $env:LOCALAPPDATA 'UnmyeongwonStudio\\gemini-api-key.dpapi'",
  '$secret = ConvertTo-SecureString -String ([IO.File]::ReadAllText($keyPath).Trim())',
  "try { [Console]::Write([System.Net.NetworkCredential]::new('', $secret).Password) } finally { $secret.Dispose() }",
].join('; ');
const encrypt = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
  '$secret = ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force',
  'try { [Console]::Write((ConvertFrom-SecureString -SecureString $secret)) } finally { $secret.Dispose() }',
].join('; ');

export function canSaveLocalGeminiKey() {
  return process.platform === 'win32' && Boolean(process.env.LOCALAPPDATA && process.env.SystemRoot);
}

function localKeyPath() {
  return join(process.env.LOCALAPPDATA, 'UnmyeongwonStudio', 'gemini-api-key.dpapi');
}

function runPowerShell(script) {
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4096,
  });
}

export async function loadLocalGeminiKey() {
  if (process.env.GEMINI_API_KEY?.trim() || !canSaveLocalGeminiKey()) return;
  try {
    await access(localKeyPath());
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const { stdout } = await runPowerShell(decrypt);
  const key = stdout.trim();
  if (!key) throw new Error('Empty protected Gemini key');
  return key;
}

export async function saveLocalGeminiKey(key) {
  const encrypted = runPowerShell(encrypt);
  encrypted.child.stdin.on('error', () => {});
  encrypted.child.stdin.end(key);
  const { stdout } = await encrypted;
  const protectedKey = stdout.trim();
  if (!/^[a-f0-9]+$/i.test(protectedKey)) throw new Error('Invalid Windows protected value');

  const path = localKeyPath();
  const temporary = join(dirname(path), randomUUID() + '.dpapi');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, protectedKey, { encoding: 'ascii', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
