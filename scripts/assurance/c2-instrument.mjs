import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const repoRoot = process.cwd();
const outputArgument = process.argv.indexOf('--out');
if (outputArgument === -1 || !process.argv[outputArgument + 1]) {
  console.error('Usage: c2-instrument.mjs --out <temporary-directory>');
  process.exit(2);
}
const outputRoot = path.resolve(repoRoot, process.argv[outputArgument + 1]);
const manifestPath = path.join(
  repoRoot,
  '.kiro', 'specs', 'domain-verification-assurance', 'evidence', 'manifests', 'c2-targets.json'
);
const plan = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const generatedConditions = [];

function sourceHash(source) {
  return createHash('sha256').update(source).digest('hex');
}

function targetForDeclaration(node, targets) {
  if (!(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))) {
    return undefined;
  }
  const name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  return name ? targets.find(target => target.symbols.includes(name)) : undefined;
}

function isLogical(node) {
  return ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken);
}

function conditionId(target, relativeSource, start, end, text) {
  const digest = createHash('sha256').update(`${relativeSource}:${start}:${end}:${text}`).digest('hex').slice(0, 12);
  return `${target.id}-${digest}`;
}

function instrumentSource(targets, relativeSource, sourceText) {
  const sourceFile = ts.createSourceFile(relativeSource, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const transformer = context => {
    const factory = context.factory;
    let activeTarget;

    const instrumentCondition = (node) => {
      if (isLogical(node)) {
        return factory.updateBinaryExpression(
          node,
          instrumentCondition(node.left),
          node.operatorToken,
          instrumentCondition(node.right)
        );
      }
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      const text = node.getText(sourceFile);
      const id = conditionId(activeTarget, relativeSource, start, end, text);
      generatedConditions.push({
        id,
        group: activeTarget.id,
        source: relativeSource,
        symbol: activeTarget.symbols,
        start,
        end,
        expression: text,
        requirements: activeTarget.requirements,
        sourceHash: sourceHash(sourceText)
      });
      return factory.createCallExpression(
        factory.createPropertyAccessExpression(factory.createIdentifier('globalThis'), '__otakProxyC2Observe'),
        undefined,
        [factory.createStringLiteral(id), node]
      );
    };

    const visitor = node => {
      const previousTarget = activeTarget;
      const declarationTarget = targetForDeclaration(node, targets);
      if (declarationTarget) activeTarget = declarationTarget;
      let updated;
      if (activeTarget && ts.isIfStatement(node)) {
        updated = factory.updateIfStatement(
          node,
          instrumentCondition(node.expression),
          ts.visitNode(node.thenStatement, visitor),
          node.elseStatement ? ts.visitNode(node.elseStatement, visitor) : undefined
        );
      } else if (activeTarget && ts.isConditionalExpression(node)) {
        updated = factory.updateConditionalExpression(
          node,
          instrumentCondition(node.condition),
          node.questionToken,
          ts.visitNode(node.whenTrue, visitor),
          node.colonToken,
          ts.visitNode(node.whenFalse, visitor)
        );
      } else if (activeTarget && ts.isWhileStatement(node)) {
        updated = factory.updateWhileStatement(node, instrumentCondition(node.expression), ts.visitNode(node.statement, visitor));
      } else if (activeTarget && ts.isDoStatement(node)) {
        updated = factory.updateDoStatement(node, ts.visitNode(node.statement, visitor), instrumentCondition(node.expression));
      } else {
        updated = ts.visitEachChild(node, visitor, context);
      }
      activeTarget = previousTarget;
      return updated;
    };
    return source => ts.visitNode(source, visitor);
  };
  return ts.transpileModule(sourceText, {
    compilerOptions: {
      module: ts.ModuleKind.Node16,
      target: ts.ScriptTarget.ES2022,
      sourceMap: false,
      inlineSourceMap: false
    },
    fileName: relativeSource,
    transformers: { before: [transformer] }
  }).outputText;
}

for (const target of plan.targets) {
  const sourcePath = path.join(repoRoot, target.source);
  const sourceText = await fs.readFile(sourcePath, 'utf8');
  const output = instrumentSource([target], target.source, sourceText);
  const outRelative = target.source.replace(/^src[\\/]/u, 'out/').replace(/\.ts$/u, '.js');
  const destination = path.join(outputRoot, outRelative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, output, 'utf8');
}

const duplicates = generatedConditions.filter((condition, index, all) =>
  all.findIndex(other => other.id === condition.id) !== index
);
if (duplicates.length > 0) {
  throw new Error(`C2 condition ID collision: ${duplicates.map(condition => condition.id).join(', ')}`);
}
const generatedManifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  typescriptVersion: ts.version,
  instrumentation: 'AST transform to temporary output only',
  conditions: generatedConditions,
  infeasible: plan.infeasible
};
await fs.mkdir(outputRoot, { recursive: true });
await fs.writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(generatedManifest, null, 2)}\n`, 'utf8');
console.log(`Instrumented ${generatedConditions.length} atomic conditions into ${outputRoot}`);
