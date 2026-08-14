import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const specRoot = path.join(repoRoot, '.kiro', 'specs', 'domain-verification-assurance');
const evidenceRoot = process.env.OTAK_PROXY_ASSURANCE_EVIDENCE_DIR ?? path.join(specRoot, 'evidence', 'runs', 'latest');
const enforceReleaseGate = process.env.OTAK_PROXY_ENFORCE_RELEASE_GATE === '1';
const requiredCommandIds = [
  'lint',
  'unit',
  'vscode-host',
  'domain-oracle',
  'pbt-replay',
  'contracts',
  'failure-injection',
  'c2',
  'mutation',
  'tla',
  'traceability',
  'final-process-cleanup'
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readJson(relativePath, fallback = undefined) {
  try {
    return JSON.parse(await fs.readFile(path.join(evidenceRoot, relativePath), 'utf8'));
  } catch (error) {
    if (fallback !== undefined && error && typeof error === 'object' && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function readText(relativePath, fallback = undefined) {
  try {
    return await fs.readFile(path.join(evidenceRoot, relativePath), 'utf8');
  } catch (error) {
    if (fallback !== undefined && error && typeof error === 'object' && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function hashAtRepositoryPath(relativePath) {
  try {
    return sha256(await fs.readFile(path.join(repoRoot, relativePath), 'utf8'));
  } catch {
    return null;
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return {
    exitCode: result.status ?? null,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? ''
  };
}

async function currentEvidenceStaleness(c2, mutation, tla) {
  const stale = [];
  for (const condition of c2?.conditions ?? []) {
    const sourceHash = await hashAtRepositoryPath(condition.source);
    if (sourceHash !== condition.sourceHash) stale.push(`C2 ${condition.id}: ${condition.source}`);
  }
  for (const mutant of mutation?.mutants ?? []) {
    const sourceHash = await hashAtRepositoryPath(mutant.source);
    if (sourceHash !== mutant.sourceSha256) stale.push(`mutation ${mutant.id}: ${mutant.source}`);
  }
  for (const run of tla?.runs ?? []) {
    const specHash = await hashAtRepositoryPath(run.source?.spec ?? '');
    const configHash = await hashAtRepositoryPath(run.source?.config ?? '');
    if (specHash !== run.source?.specSha256) stale.push(`TLA+ ${run.id}: ${run.source?.spec}`);
    if (configHash !== run.source?.configSha256) stale.push(`TLA+ ${run.id}: ${run.source?.config}`);
  }
  return stale;
}

async function writeAtomically(fileName, value) {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const destination = path.join(evidenceRoot, fileName);
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, destination);
}

function enrichFinding(finding) {
  const severity = finding.severity ?? 'medium';
  if (severity === 'high') {
    return {
      ...finding,
      impact: 'release-criticalな保証が欠け、誤ったリリース判定又は状態不整合を見逃す可能性がある。',
      likelihood: '未検証又は失敗した経路が実行される環境では不明。安全側に高いと扱う。',
      detectability: '既存の成功テストだけでは検出できない。対応するgate又は追加の再現試験が必要。',
      mitigation: '原因を修正又は対象を検証し、該当gateを再実行してPASSへ更新する。',
      owner: 'release owner と対象コンポーネントのmaintainer'
    };
  }
  return {
    ...finding,
    impact: '保証の一般化範囲が狭く、特定環境又は未探索入力で差異が生じうる。',
    likelihood: '有限探索外、provider差、又は未再現の故障条件で発現しうる。',
    detectability: '運用監視、既存の診断、又は追加の境界テストで検出可能だが、現行gateだけでは完全ではない。',
    mitigation: '抽象化差を監視し、対象が変わる際は境界テスト／TLC定数行列を拡張して再監査する。',
    owner: 'release owner と対象コンポーネントのmaintainer'
  };
}

const [assuranceRun, c2, mutation, tla, traceability, environmentObservation] = await Promise.all([
  readJson('assurance-run.json', null),
  readJson('c2.json', null),
  readJson('mutation.json', null),
  readJson('tla.json', null),
  readJson('traceability.json', null),
  readText('environment-observations.md', null)
]);

const commandById = new Map((assuranceRun?.checks ?? []).map(check => [check.id, check]));
const failedCommands = requiredCommandIds.filter(id => !commandById.get(id)?.passed);
const staleEvidence = await currentEvidenceStaleness(c2, mutation, tla);
const traceIntegrityProblems = traceability?.checks?.integrityProblems ?? ['traceability evidence is missing'];
const unverifiedRequirements = (traceability?.requirements ?? [])
  .filter(requirement => requirement.status === 'unverified')
  .map(requirement => requirement.id);
const technicalGates = [
  {
    id: 'GATE-COMMANDS',
    passed: Boolean(assuranceRun) && failedCommands.length === 0,
    detail: failedCommands.length === 0 ? '全必須コマンドが終了コード0で完了' : `失敗又は未記録: ${failedCommands.join(', ')}`
  },
  {
    id: 'GATE-PROCESS-CLEANUP',
    passed: Boolean(commandById.get('final-process-cleanup')?.passed),
    detail: '最終runner-survivors=0 の証跡'
  },
  {
    id: 'GATE-C2',
    passed: c2?.feasibleC2 === 100 && c2?.unobserved?.length === 0,
    detail: c2 ? `feasible C2=${c2.feasibleC2}%, unobserved=${c2.unobserved?.length ?? 'unknown'}` : 'C2証跡なし'
  },
  {
    id: 'GATE-MUTATION',
    passed: mutation?.adjustedMutationScore === 100
      && mutation?.survived === 0
      && mutation?.equivalent === 0
      && mutation?.timeout === 0
      && mutation?.noCoverage === 0
      && mutation?.compileError === 0
      && mutation?.unclassified === 0,
    detail: mutation ? `score=${mutation.adjustedMutationScore}%, survived=${mutation.survived}, equivalent=${mutation.equivalent}` : 'mutation証跡なし'
  },
  {
    id: 'GATE-TLA',
    passed: tla?.allPassed === true && (tla?.runs?.length ?? 0) >= 7,
    detail: tla ? `allPassed=${tla.allPassed}, models=${tla.runs?.length ?? 0}` : 'TLC証跡なし'
  },
  {
    id: 'GATE-TRACEABILITY',
    passed: traceIntegrityProblems.length === 0,
    detail: `integrityProblems=${traceIntegrityProblems.length}`
  },
  {
    id: 'GATE-RELEASE-CRITICAL-SCOPE',
    passed: unverifiedRequirements.length === 0,
    detail: unverifiedRequirements.length === 0
      ? '未検証のacceptance requirementなし'
      : `未検証: ${unverifiedRequirements.join(', ')}`
  },
  {
    id: 'GATE-FRESHNESS',
    passed: staleEvidence.length === 0,
    detail: staleEvidence.length === 0 ? 'C2/mutation/TLA+のsource hashが現在の入力と一致' : staleEvidence.join('; ')
  }
];
const allTechnicalGatesPassed = technicalGates.every(gate => gate.passed);
const allGatesPassed = allTechnicalGatesPassed;
const releaseDecision = allGatesPassed ? 'CONDITIONAL-GO' : 'NO-GO';
const adversarialFindings = [
  ...technicalGates.filter(gate => !gate.passed).map(gate => ({ severity: 'high', gate: gate.id, detail: gate.detail })),
  ...(traceability?.releaseGaps ?? []).map(gap => ({ severity: gap.status === 'unverified' ? 'high' : 'medium', requirement: gap.id, detail: gap.gap })),
  ...(environmentObservation ? [{
    severity: 'medium',
    category: 'environment-harness',
    detail: 'VS Code host実行時のharness診断は environment-observations.md に記録した。テスト結果とcleanupは成功したが、ランチャー更新時に再確認する。'
  }] : []),
  {
    severity: 'medium',
    category: 'model-abstraction',
    detail: 'TLA+ は有限actor/時刻/resource/epoch/queueの抽象であり、無制限の値空間、credential値、実lock相互排他、全永続化targetは未探索。'
  },
  {
    severity: 'medium',
    category: 'environment-assumption',
    detail: 'sync livenessは信頼配送（MaxDrops=0）と明示したweak fairnessの仮定に依存する。loss-boundary反例はこの依存を確認している。'
  }
].map(enrichFinding);
const gitHead = git(['rev-parse', 'HEAD']);
const gitStatus = git(['status', '--porcelain=v1']);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  decision: releaseDecision,
  enforceReleaseGate,
  technicalGates,
  summary: {
    allTechnicalGatesPassed,
    allGatesPassed,
    c2FeasiblePercent: c2?.feasibleC2 ?? null,
    mutationScore: mutation?.adjustedMutationScore ?? null,
    survivingMutants: mutation?.survived ?? null,
    equivalentMutants: mutation?.equivalent ?? null,
    tlcAllPassed: tla?.allPassed ?? null,
    traceabilityIntegrityProblems: traceIntegrityProblems.length,
    traceabilityStatusCounts: traceability?.statusCounts ?? null,
    unverifiedRequirements,
    staleEvidence
  },
  provenance: {
    gitHead: gitHead.exitCode === 0 ? gitHead.stdout : null,
    workingTree: gitStatus.exitCode === 0 ? gitStatus.stdout.split(/\r?\n/u).filter(Boolean) : [],
    evidenceRoot: path.relative(repoRoot, evidenceRoot),
    assuranceRunGeneratedAt: assuranceRun?.generatedAt ?? null
  },
  adversarialFindings
};
await writeAtomically('adversarial-audit.json', report);
const markdown = [
  '# 敵対的再監査・リリース判定',
  '',
  `- 判定: **${report.decision}**`,
  `- 実行記録: ${report.provenance.assuranceRunGeneratedAt ?? 'なし'}`,
  `- C2: ${report.summary.c2FeasiblePercent ?? 'なし'}%`,
  `- mutation: ${report.summary.mutationScore ?? 'なし'}%（surviving ${report.summary.survivingMutants ?? 'なし'}、equivalent ${report.summary.equivalentMutants ?? 'なし'}）`,
  `- TLC: allPassed=${report.summary.tlcAllPassed ?? 'なし'}`,
  `- 対応表の整合性問題: ${report.summary.traceabilityIntegrityProblems}`,
  `- 未検証acceptance requirement: ${report.summary.unverifiedRequirements.join(', ') || 'なし'}`,
  '',
  '## Gate',
  '',
  '| Gate | Result | Evidence |',
  '| --- | --- | --- |',
  ...technicalGates.map(gate => `| ${gate.id} | ${gate.passed ? 'PASS' : 'FAIL'} | ${gate.detail} |`),
  '',
  '## 残存リスク・未検証範囲',
  '',
  ...adversarialFindings.map(finding => [
    `- [${finding.severity}] ${finding.gate ?? finding.requirement ?? finding.category ?? 'finding'}: ${finding.detail}`,
    `  - 影響: ${finding.impact}`,
    `  - 発生可能性: ${finding.likelihood}`,
    `  - 検出可能性: ${finding.detectability}`,
    `  - 軽減策: ${finding.mitigation}`,
    `  - owner: ${finding.owner}`
  ].join('\n')),
  '',
  '## 判定根拠',
  '',
  report.decision === 'NO-GO'
    ? '必須gateの未充足を残したままリリースは承認しない。失敗又は未検証のacceptance requirementを解消して、監査を再実行する必要がある。'
    : '制御済みの検証gateは充足している。有限探索、test doubleと実環境の差、未採用の入力領域を条件・監視・rollbackを伴う残存リスクとして扱うため、判定はCONDITIONAL-GOとする。'
].join('\n');
await fs.writeFile(path.join(evidenceRoot, 'adversarial-audit.md'), `${markdown}\n`, 'utf8');
const releaseAssessment = [
  '# リリース評価',
  '',
  `- 判定: **${report.decision}**`,
  '- 判定方式: C2、mutation、TLC、traceability、全実行コマンド、process cleanup、証跡freshnessを機械gateとして評価した。',
  '- 実機依存の成功主張は本仕様の対象外であり、制御済みテストと形式検査の範囲だけを根拠とする。',
  '',
  '## Gate結果',
  '',
  ...technicalGates.map(gate => `- ${gate.id}: ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.detail}`),
  '',
  '## release条件',
  '',
  report.decision === 'NO-GO'
    ? '- 未充足gateを解消し、同じ一括verificationと敵対的監査を再実行するまでリリースしない。'
    : '- CONDITIONAL-GO: 変更が状態モデル、外部境界、TLC定数、又はprovider契約を拡張する場合は、本評価を無効化して対応するテスト／モデルを追加する。rollbackは拡張機能を無効化又は既知の安定版へ戻すことで行う。',
  '',
  '## 残存リスク',
  '',
  ...adversarialFindings.filter(finding => finding.severity !== 'high').map(finding => `- ${finding.requirement ?? finding.category ?? 'finding'}: ${finding.detail}`)
].join('\n');
await fs.writeFile(path.join(evidenceRoot, 'release-assessment.md'), `${releaseAssessment}\n`, 'utf8');
console.log(`adversarial-audit decision=${releaseDecision} technical=${allTechnicalGatesPassed} unverified=${unverifiedRequirements.length}`);
if (enforceReleaseGate && releaseDecision === 'NO-GO') process.exitCode = 1;
