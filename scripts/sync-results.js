const fs = require('node:fs');
const path = require('node:path');
const publication = require('../lib/publication-state');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(args) {
  const modes = ['--dry-run', '--prepare', '--begin', '--receipt', '--check', '--finalize-interrupted'];
  const mode = args[0];
  if (!modes.includes(mode)) throw new Error('Use --dry-run, --prepare, --begin OPERATION, --receipt FILE, --check, or --finalize-interrupted');
  const options = {};
  let operand;
  for (let index = 1; index < args.length; index += 1) {
    if (['--report', '--config'].includes(args[index])) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Option requires a path');
      options[args[index].slice(2)] = args[++index];
    } else if (!operand && ['--begin', '--receipt'].includes(mode)) operand = args[index];
    else throw new Error('Unknown synchronization argument');
  }
  const reportPath = path.resolve(options.report || readJson('artifacts/latest.json').report);
  const report = readJson(reportPath);
  const catalog = readJson('tests/catalog.json');
  if (mode === '--finalize-interrupted') {
    if (report.endedAt) throw new Error('Only unfinished reports can be finalized as interrupted');
    report.status = 'interrupted';
    report.endedAt = new Date().toISOString();
    publication.validateExecution(catalog, report);
    publication.writeAtomic(reportPath, report);
    return { publication: 'pending', message: 'Interrupted evidence finalized locally; no MCP writes' };
  }
  publication.validateExecution(catalog, report);
  const configPath = path.resolve(options.config || 'config/integrations.json');
  if (mode === '--dry-run') {
    let readiness = 'pending: destinations and authenticated MCP discovery required';
    if (fs.existsSync(configPath)) {
      publication.validateConfiguration(readJson(configPath));
      readiness = 'configured: MCP authentication and remote receipts still required';
    }
    return { executionId: report.executionId, publication: 'pending', readiness, writesPerformed: 0,
      scenarios: report.scenarios.map(scenario => ({ id: scenario.id, status: scenario.status,
        operations: ['reconcile/import case', 'create execution run', ...(publication.isFailure(scenario) ? ['create fresh Jira defect'] : []), 'publish TestRail result'] })) };
  }
  if (!fs.existsSync(configPath)) throw new Error('Publishing pending: configure destinations and discover MCP metadata in config/integrations.json');
  const config = readJson(configPath);
  publication.validateConfiguration(config);
  const statePath = path.resolve('artifacts/publication', `${publication.destinationKey(config)}.json`);
  return publication.withState(statePath, publication.newState(config), state => {
    const execution = publication.prepare(state, catalog, report, config);
    let request;
    if (mode === '--begin') {
      if (!operand) throw new Error('--begin requires an operation ID');
      request = publication.begin(state, report.executionId, operand);
    }
    if (mode === '--receipt') {
      if (!operand) throw new Error('--receipt requires a sanitized receipt file');
      publication.receipt(state, report.executionId, readJson(operand));
    }
    const output = { executionId: report.executionId, publication: execution.completed ? 'complete' : 'pending',
      writesPerformed: 0, state: path.relative(process.cwd(), statePath).split(path.sep).join('/'),
      message: 'Local state only. BMad must invoke discovered TestRail/Rovo MCP tools and record each receipt.',
      ...(request ? { request } : {}),
      operations: Object.values(execution.operations).map(operation => ({ id: operation.id, kind: operation.kind,
        identity: operation.identity, status: operation.status, remoteId: operation.remoteId,
        dependencies: operation.dependencies,
        ...(operation.dependencies.every(id => execution.operations[id].status === 'confirmed') ? { intent: publication.requestIntent(state, report.executionId, operation.id) } : {}) })) };
    if (mode === '--check' && !execution.completed) process.exitCode = 1;
    return output;
  });
}

if (require.main === module) {
  const secrets = Object.entries(process.env).filter(([key]) => /password|secret|token|api.?key|username/i.test(key)).map(([, value]) => value);
  try { console.log(JSON.stringify(publication.redact(run(process.argv.slice(2)), secrets), null, 2)); }
  catch (error) {
    console.error(JSON.stringify({ publication: 'pending', writesPerformed: 0, error: publication.redact(error.message, secrets) }));
    process.exitCode = 1;
  }
}

module.exports = { run };