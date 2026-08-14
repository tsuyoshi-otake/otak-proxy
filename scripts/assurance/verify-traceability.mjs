import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const specRoot = path.join(repoRoot, '.kiro', 'specs', 'domain-verification-assurance');
const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(specRoot, 'evidence', 'runs', 'latest');
const stage = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] ?? 'all' : 'all';

const groupMappings = {
  1: {
    status: 'verified',
    summary: '対象、根拠、設計履歴、状態／境界台帳を固定する。',
    oracles: ['DOM-MODE', 'DOM-APPLY', 'DOM-TARGET', 'DOM-SYNC', 'DOM-LIFECYCLE', 'DOM-RECOVERY'],
    implementation: ['src/core/ProxyStateManager.ts', 'src/core/v3Types.ts', 'src/sync/ConflictResolver.ts'],
    evidence: ['evidence/manifests/domain-decisions.json', 'evidence/state-transitions.md', 'evidence/failure-matrix.md', 'evidence/assumptions.md']
  },
  2: {
    status: 'verified',
    summary: 'literal-onlyオラクル、決定表、具体例、negative control。',
    oracles: ['DomainModel', 'DecisionTables', 'DomainOracle'],
    tests: ['ORC-MODE-*', 'ORC-APPLY-*', 'ORC-TARGET-*', 'ORC-SYNC-*', 'ORC-LIFECYCLE-001', 'ORC-RECOVERY-001'],
    implementation: ['src/test/assurance/oracle/DomainOracle.ts', 'src/test/assurance/oracle/SUTAdapters.ts'],
    evidence: ['src/test/assurance/DomainOracle.examples.test.ts', 'evidence/manifests/domain-decisions.json']
  },
  3: {
    status: 'verified',
    summary: '固定seed PBT、縮小済みcalibration反例、単独replay。',
    pbt: ['PBT-MODE-001', 'PBT-APPLY-001', 'PBT-TARGET-001', 'PBT-SYNC-001', 'PBT-LIFECYCLE-001', 'PBT-RECOVERY-001', 'PBT-CAL-001'],
    evidence: ['src/test/assurance/DomainOracle.property.test.ts', 'src/test/assurance/support/PbtLedger.ts', 'evidence/pbt/replay-fixtures.json', 'scripts/assurance/run-pbt-replay.mjs']
  },
  4: {
    status: 'verified',
    summary: 'AST計測による実行可能原子条件C2。',
    c2: ['C2-MODE', 'C2-APPLY', 'C2-TARGET', 'C2-SYNC'],
    evidence: ['evidence/manifests/c2-targets.json', 'scripts/assurance/c2-instrument.mjs', 'scripts/assurance/run-c2.mjs', 'evidence/runs/latest/c2.json']
  },
  5: {
    status: 'verified',
    summary: '隔離済みコンパイル出力への一変異実行と分類。',
    mutants: ['MNT-MODE-001', 'MNT-APPLY-*', 'MNT-TARGET-*', 'MNT-SYNC-*', 'MNT-LIFECYCLE-001', 'MNT-PERSIST-001'],
    evidence: ['evidence/manifests/mutation-scope.json', 'scripts/assurance/run-mutation.mjs', 'scripts/assurance/mutation-hook.cjs', 'evidence/runs/latest/mutation.json']
  },
  6: {
    status: 'verified',
    summary: '状態、event、guard、terminal、永続化境界、最終化所有者を台帳化する。',
    boundaries: ['BND-GSTATE', 'BND-SECRET', 'BND-VSCODE', 'BND-CLI', 'BND-SHARED-FS', 'BND-REGISTRY', 'BND-APPLY-LOCK', 'BND-PROXY', 'BND-TIMER'],
    evidence: ['evidence/state-transitions.md', 'evidence/manifests/domain-decisions.json']
  },
  7: {
    status: 'partial',
    summary: 'CLI、VS Code storage、shared filesystem、local proxyのプロトコル互換境界を検査する。watch/pollと多actorの実filesystem競合は未再現として残す。',
    tests: ['CT-CLI-GIT-001', 'CT-CLI-NPM-001', 'CT-CLI-PIP-001', 'CT-OPTIONAL-001', 'CT-VSCODE-001', 'CT-STATE-001', 'CT-PROXY-001'],
    implementation: ['src/config/GitConfigManager.ts', 'src/config/NpmConfigManager.ts', 'src/sync/SharedStateFile.ts'],
    evidence: ['src/test/assurance/ExternalBoundary.contract.test.ts', 'evidence/assumptions.md']
  },
  8: {
    status: 'partial',
    summary: '決定的fault injectionで資源、retry、部分失敗、event、cancel、crash/restartを検査する。未実装の資源型とprovider固有の故障形は残存リスクとして明示する。',
    faults: ['F-BND-001', 'F-PARTIAL-001', 'F-RETRY-001', 'F-EVENT-001', 'F-CANCEL-001', 'F-TIMEOUT-001', 'F-CRASH-001', 'F-RESOURCE-001'],
    tests: ['F-RESOURCE-001', 'F-PERSIST-RETRY-001', 'F-PARTIAL-001', 'F-DETECT-RETRY-001', 'F-EVENT-001', 'F-CANCEL-001', 'F-CRASH-001'],
    tla: ['TLC-LIFECYCLE-*', 'TLC-SYNC-*'],
    evidence: ['evidence/failure-matrix.md', 'src/test/assurance/FailureInjection.integration.test.ts', 'evidence/runs/latest/tla.json']
  },
  9: {
    status: 'partial',
    summary: '実装非依存のlifecycle/sync有限抽象。targetごとの永続境界モデルは次段階。',
    tla: ['ProxyLifecycle: Start/BeginCheck/Complete/Stop/Timeout/Crash/Restart/Recover/LateComplete', 'SyncConvergence: Publish/Duplicate/Deliver/Drop'],
    implementation: ['src/monitoring/ProxyMonitor.ts', 'src/sync/ConflictResolver.ts', 'src/sync/SharedStateFile.ts'],
    evidence: ['formal/ProxyLifecycle.tla', 'formal/SyncConvergence.tla', 'formal/README.md', 'evidence/runs/latest/tla.json']
  },
  10: {
    status: 'partial',
    summary: '固定seedのTLC BFS、Safety/Liveness/deadlock、期待反例到達性を記録する。無制限定数とcredential値は未探索。',
    tla: ['TLC-LIFECYCLE-SMALL', 'TLC-LIFECYCLE-MEDIUM', 'TLC-LIFECYCLE-REQUIRED-APPLIED', 'TLC-SYNC-RELIABLE-SMALL', 'TLC-SYNC-RELIABLE-MEDIUM', 'TLC-SYNC-LOSS-BOUNDARY', 'TLC-SYNC-DIVERGENCE-REACHABILITY'],
    evidence: ['scripts/assurance/run-tla.mjs', 'evidence/runs/latest/tla.json', 'evidence/runs/latest/tla.md']
  },
  11: {
    status: 'verified',
    summary: '一時出力、redaction、制御済みの境界／extension-hostテスト、runner cleanupを実装し、実機E2Eは方針上の対象外として明記する。',
    evidence: ['src/test/assurance/ExternalBoundary.contract.test.ts', 'src/test/assurance/support/PbtLedger.ts', 'scripts/assurance/cleanup-test-processes.mjs', 'scripts/assurance/run-assurance.mjs', 'evidence/assumptions.md']
  },
  12: {
    status: 'partial',
    summary: '機械検査可能な対応表と敵対的再監査を生成する。release gateは制御済み検証の結果と明示した残存リスクに基づき判定する。',
    evidence: ['scripts/assurance/verify-traceability.mjs', 'scripts/assurance/run-adversarial-audit.mjs', 'evidence/runs/latest/traceability.json', 'evidence/runs/latest/adversarial-audit.json', 'evidence/runs/latest/release-assessment.md']
  }
};

const overrides = {
  'DVA-1.5': { status: 'partial', gap: '不一致は未発生であり、実不一致の最小再現記録はcalibration以外では未取得。' },
  'DVA-2.3': { status: 'partial', gap: '代表的な無効／境界値はあるが、全入力形式の無効値体系は未網羅。' },
  'DVA-2.4': { status: 'partial', gap: 'オラクルは許可／禁止副作用を定義するが、全SUT adapterが実副作用列を返して比較する構造ではない。' },
  'DVA-2.6': { status: 'partial', gap: '不一致分類の自動artifactは未実装。' },
  'DVA-3.7': { status: 'partial', gap: 'runId/atomic writeは実装済みだが、並列競合を専用負荷テストしていない。' },
  'DVA-4.5': { status: 'verified', note: '到達不能条件は0件。除外せず全24条件を計測した。' },
  'DVA-7.1': { status: 'partial', gap: 'port化した境界はGit/npm/shared filesystemに限定される。' },
  'DVA-7.3': { status: 'verified', note: 'CT-VSCODE-001がMemento、SecretStorage、Configuration更新／event、EnvironmentVariableCollectionをproduction manager接続で検証する。' },
  'DVA-7.4': { status: 'partial', gap: '実filesystemのatomic write/rename/破損復旧は確認済みだが、watch/pollと多actor競合の実filesystem結合は未実施。' },
  'DVA-8.1': { status: 'partial', gap: 'テスト内注入は決定的だが、共通FaultPlan台帳／解除条件の実装は未完了。' },
  'DVA-8.2': { status: 'partial', gap: '主要な0/1/上限境界はPBT/TLAで扱うが、全資源型のmax-1/max/max+1は未実施。' },
  'DVA-8.4': { status: 'partial', gap: 'retry上限、backoff、成功時resetは確認済み。Retry-After provider契約は未再現。' },
  'DVA-8.6': { status: 'partial', gap: 'stop後の遅延完了とproxy timeoutは確認済みだが、全cancel/timeout所有者を網羅していない。' },
  'DVA-8.8': { status: 'partial', gap: 'ENOSPC/EACCESは確認済み。EMFILE、lock枯渇、queue上限の実装結合注入は未実施。' },
  'DVA-9.2': { status: 'partial', gap: '複数actor/in-flight/event競合はモデル化済み。複数targetと全永続境界の状態は未抽象化。' },
  'DVA-10.4': { status: 'partial', gap: 'actor/retry/resource/timeは変化させたが、target数の定数行列は未実装。' },
  'DVA-10.5': { status: 'partial', gap: 'resource/epoch/単調replica/禁止状態を検査。credential値と実lock相互排他はTLAで未モデル化。' },
  'DVA-10.6': { status: 'partial', gap: 'Checking→Applied/Stopped/Failed/Crashedとsync収束を検査。partial/awaitingUser/cancelled全terminal集合は未モデル化。' },
  'DVA-10.7': { status: 'partial', gap: 'TLC deadlock検査は有効だが、抽象モデルはPulse Actionでterminalを進行可能に表現する。' },
  'DVA-11.1': { status: 'verified', note: '既存VS Code runnerの一意profile・config redirectと全体検証のhost実行証跡で確認する。' },
  'DVA-11.4': { status: 'verified', note: 'プロトコル互換結合、failure injection、隔離VS Code hostを実行する。' },
  'DVA-11.5': { status: 'verified', note: 'test doubleの抽象化差と未再現のOS/provider動作をassumptionsと敵対的監査へ記録する。' },
  'DVA-11.6': { status: 'verified', note: '隔離Windows VMでの実機E2Eは本仕様の対象外であり、実機依存の成功主張を行わない。' },
  'DVA-12.5': { status: 'partial', gap: 'C2/mutation及びSafety gateの実行結果は敵対的監査で判定する。' },
  'DVA-12.6': { status: 'verified', note: 'release-criticalな未検証境界、重大な探索不足、mutation scoreを明示的にgate判定する。' },
  'DVA-12.7': { status: 'partial', gap: '有限探索とtest doubleの抽象化差はCONDITIONAL-GOの残存リスクとして監査結果へ記録する。' }
};

const requiredArtifacts = [
  'evidence/manifests/domain-decisions.json',
  'evidence/manifests/c2-targets.json',
  'evidence/manifests/mutation-scope.json',
  'evidence/state-transitions.md',
  'evidence/failure-matrix.md',
  'evidence/assumptions.md',
  'evidence/pbt/replay-fixtures.json',
  'src/test/assurance/DomainOracle.examples.test.ts',
  'src/test/assurance/DomainOracle.property.test.ts',
  'src/test/assurance/ExternalBoundary.contract.test.ts',
  'src/test/assurance/FailureInjection.integration.test.ts',
  'scripts/assurance/run-c2.mjs',
  'scripts/assurance/run-mutation.mjs',
  'scripts/assurance/run-tla.mjs',
  'scripts/assurance/run-adversarial-audit.mjs',
  'formal/ProxyLifecycle.tla',
  'formal/SyncConvergence.tla',
  'evidence/runs/latest/c2.json',
  'evidence/runs/latest/mutation.json',
  'evidence/runs/latest/tla.json'
];

async function exists(relativePath) {
  try {
    const base = relativePath.startsWith('evidence/') ? specRoot : repoRoot;
    await fs.access(path.join(base, relativePath));
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values)];
}

function requirementStatement(requirementsSource, id) {
  return requirementsSource.split(/\r?\n/u).find(line => line.includes(`**${id}**`))?.trim() ?? '';
}

function testIdsFrom(source) {
  return [...source.matchAll(/\b(?:ORC|PBT|CT|F)-[A-Z]+(?:-[A-Z]+)*-\d+\b/gu)].map(match => match[0]);
}

const requirementsPath = path.join(specRoot, 'requirements.md');
const [requirementsSource, domainSource, mutationScopeSource, c2Source, pbtFixtureSource, ...testSources] = await Promise.all([
  fs.readFile(requirementsPath, 'utf8'),
  fs.readFile(path.join(specRoot, 'evidence', 'manifests', 'domain-decisions.json'), 'utf8'),
  fs.readFile(path.join(specRoot, 'evidence', 'manifests', 'mutation-scope.json'), 'utf8'),
  fs.readFile(path.join(specRoot, 'evidence', 'manifests', 'c2-targets.json'), 'utf8'),
  fs.readFile(path.join(specRoot, 'evidence', 'pbt', 'replay-fixtures.json'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'test', 'assurance', 'DomainOracle.examples.test.ts'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'test', 'assurance', 'DomainOracle.property.test.ts'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'test', 'assurance', 'ExternalBoundary.contract.test.ts'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'test', 'assurance', 'FailureInjection.integration.test.ts'), 'utf8')
]);
const domainManifest = JSON.parse(domainSource);
const mutationScope = JSON.parse(mutationScopeSource);
const c2Targets = JSON.parse(c2Source);
const pbtFixtures = JSON.parse(pbtFixtureSource);
const requirementIds = [...requirementsSource.matchAll(/\bDVA-\d+\.\d+\b/gu)].map(match => match[0]);
const uniqueRequirementIds = unique(requirementIds);
const duplicateRequirementIds = uniqueRequirementIds.filter(id => requirementIds.filter(candidate => candidate === id).length !== 1);
const mappedRequirementIds = uniqueRequirementIds.filter(id => groupMappings[Number(id.match(/DVA-(\d+)\./u)?.[1])]);

const knownTestIds = new Set([
  ...domainManifest.decisions.flatMap(decision => [...decision.oracleCases, ...decision.properties]),
  ...Object.keys(pbtFixtures.generatorVersions),
  'CT-CLI-GIT-001', 'CT-CLI-NPM-001', 'CT-CLI-PIP-001', 'CT-OPTIONAL-001', 'CT-VSCODE-001', 'CT-STATE-001', 'CT-PROXY-001',
  'F-RESOURCE-001', 'F-PERSIST-RETRY-001', 'F-PARTIAL-001', 'F-DETECT-RETRY-001', 'F-EVENT-001', 'F-CANCEL-001', 'F-CRASH-001'
]);
const discoveredTestIds = unique(testSources.flatMap(testIdsFrom));
const orphanedTestIds = discoveredTestIds.filter(id => !knownTestIds.has(id));
const missingMappedTestIds = [...knownTestIds].filter(id => !discoveredTestIds.includes(id) && !id.startsWith('ORC-') && !id.startsWith('PBT-'));
const mutationUnknownTests = mutationScope.mutants.flatMap(mutant => mutant.tests.filter(id => !knownTestIds.has(id)));
const unknownRequirementReferences = unique([
  ...domainSource.matchAll(/\bDVA-\d+\.\d+\b/gu),
  ...mutationScopeSource.matchAll(/\bDVA-\d+\.\d+\b/gu),
  ...c2Source.matchAll(/\bDVA-\d+\.\d+\b/gu)
].map(match => match[0])).filter(id => !uniqueRequirementIds.includes(id));
const missingArtifacts = [];
for (const artifact of requiredArtifacts) {
  if (!(await exists(artifact))) missingArtifacts.push(artifact);
}

const rows = uniqueRequirementIds.map(id => {
  const groupNumber = Number(id.match(/DVA-(\d+)\./u)?.[1]);
  const base = groupMappings[groupNumber];
  const override = overrides[id] ?? {};
  return {
    id,
    statement: requirementStatement(requirementsSource, id),
    status: override.status ?? base.status,
    summary: base.summary,
    gap: override.gap ?? null,
    note: override.note ?? null,
    oracle: base.oracles ?? [],
    tests: base.tests ?? [],
    pbt: base.pbt ?? [],
    c2: base.c2 ?? [],
    mutants: base.mutants ?? [],
    tla: base.tla ?? [],
    boundaries: base.boundaries ?? [],
    faults: base.faults ?? [],
    implementation: base.implementation ?? [],
    evidence: base.evidence
  };
});

const integrityProblems = [
  ...duplicateRequirementIds.map(id => `Requirement ID is not unique: ${id}`),
  ...uniqueRequirementIds.filter(id => !mappedRequirementIds.includes(id)).map(id => `Requirement is unmapped: ${id}`),
  ...orphanedTestIds.map(id => `Stable test ID is orphaned: ${id}`),
  ...missingMappedTestIds.map(id => `Mapped concrete test ID is absent: ${id}`),
  ...unique(mutationUnknownTests).map(id => `Mutation scope references an unknown test ID: ${id}`),
  ...unknownRequirementReferences.map(id => `Artifact references unknown requirement ID: ${id}`),
  ...missingArtifacts.map(file => `Required artifact is missing: ${file}`)
];
const statusCounts = Object.fromEntries(['verified', 'partial', 'unverified'].map(status => [
  status,
  rows.filter(row => row.status === status).length
]));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  stage,
  requirements: rows,
  statusCounts,
  checks: {
    totalRequirementIds: requirementIds.length,
    uniqueRequirementIds: uniqueRequirementIds.length,
    duplicateRequirementIds,
    orphanedTestIds,
    missingMappedTestIds,
    mutationUnknownTests: unique(mutationUnknownTests),
    unknownRequirementReferences,
    missingArtifacts,
    integrityProblems
  },
  releaseGaps: rows.filter(row => row.status !== 'verified').map(row => ({ id: row.id, status: row.status, gap: row.gap ?? row.summary }))
};
await fs.mkdir(evidenceRoot, { recursive: true });
await fs.writeFile(path.join(evidenceRoot, 'traceability.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const markdown = [
  '# 要件・検証対応表',
  '',
  `- 対象受入基準: ${report.checks.uniqueRequirementIds}`,
  `- 機械整合性問題: ${integrityProblems.length}`,
  `- verified: ${statusCounts.verified}; partial: ${statusCounts.partial}; unverified: ${statusCounts.unverified}`,
  '',
  '| 要件 | 状態 | オラクル／テスト／PBT／C2／mutation／TLA+ | 実装・証跡 | 残課題 |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(row => {
    const verification = [
      ...row.oracle, ...row.tests, ...row.pbt, ...row.c2, ...row.mutants, ...row.tla
    ].join('<br>') || '—';
    const implementation = [...row.implementation, ...row.evidence].join('<br>') || '—';
    return `| ${row.id} | ${row.status} | ${verification} | ${implementation} | ${row.gap ?? row.note ?? '—'} |`;
  }),
  '',
  '## 機械検査結果',
  '',
  ...(integrityProblems.length === 0 ? ['- 参照先不存在、重複要件ID、孤立stable test ID、証跡欠落は検出されなかった。'] : integrityProblems.map(problem => `- ${problem}`))
].join('\n');
await fs.writeFile(path.join(evidenceRoot, 'traceability.md'), `${markdown}\n`, 'utf8');
console.log(`traceability requirements=${rows.length} integrity-problems=${integrityProblems.length} verified=${statusCounts.verified} partial=${statusCounts.partial} unverified=${statusCounts.unverified}`);
if (integrityProblems.length > 0) process.exitCode = 1;
