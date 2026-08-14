import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(
  repoRoot,
  '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'runs', 'latest'
);
const script = [
  '$root = [Environment]::GetEnvironmentVariable("OTAK_PROXY_ASSURANCE_REPO")',
  '$self = [Environment]::GetEnvironmentVariable("OTAK_PROXY_ASSURANCE_SELF")',
  '$items = Get-CimInstance Win32_Process | Where-Object {',
  '  $_.ProcessId -ne [int]$self -and $_.CommandLine -and $_.CommandLine -like "*$root*" -and $_.Name -match "^(node|electron|Code).*"',
  '} | Select-Object ProcessId,ParentProcessId,Name,CommandLine',
  '$items | ConvertTo-Json -Compress'
].join('; ');
const result = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
  encoding: 'utf8',
  env: {
    ...process.env,
    OTAK_PROXY_ASSURANCE_REPO: repoRoot,
    OTAK_PROXY_ASSURANCE_SELF: String(process.pid)
  }
});
if (result.status !== 0) {
  process.stderr.write(result.stderr || 'Failed to inspect test processes\n');
  process.exit(result.status ?? 1);
}
const stdout = result.stdout.trim();
const survivors = stdout ? JSON.parse(stdout) : [];
const normalized = Array.isArray(survivors) ? survivors : [survivors];
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(path.join(evidenceRoot, 'process-cleanup.json'), `${JSON.stringify({
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  repository: repoRoot,
  survivors: normalized
}, null, 2)}\n`, 'utf8');
if (normalized.length > 0) {
  console.error(`Found ${normalized.length} test runner process(es) still attached to the repository.`);
  process.exit(1);
}
console.log('runner-survivors=0');
