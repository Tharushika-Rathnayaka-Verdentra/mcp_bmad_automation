const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const publication = require('../../lib/publication-state');
const catalog = require('../catalog.json');

function configuration() {
  return {
    schemaVersion: 1,
    testrail: { instanceUrl: 'https://example.testrail.io', projectId: 7, suiteId: 8, sectionId: 9, templateId: 2,
      fields: { preconditions: 'custom_preconds', steps: 'custom_steps_separated' }, caseDefaults: {},
      statusMap: { passed: 'passed', failed: 'failed', timedOut: 'failed', skipped: 'blocked', interrupted: 'blocked' } },
    jira: { cloudId: 'cloud-id', projectKey: 'QA', issueTypeId: '10001', fields: {} },
    discovery: { verifiedAt: '2026-11-08T00:00:00Z', toolSchemasValidated: true,
      statuses: [{ id: 11, name: 'passed' }, { id: 15, name: 'failed' }, { id: 12, name: 'blocked' }],
      caseFieldNames: ['custom_preconds', 'custom_steps_separated'], resultFieldNames: ['status_id', 'comment', 'elapsed', 'defects'],
      requiredCaseFields: [], requiredJiraFields: [] }
  };
}

function report(statuses = ['passed'], executionId = 'execution-0001') {
  return { schemaVersion: 1, executionId, target: catalog.target, startedAt: '2026-11-08T00:00:00Z',
    endedAt: '2026-11-08T00:01:00Z', status: statuses.every(status => status === 'passed') ? 'passed' : 'failed',
    publication: 'pending', errors: [], scenarios: statuses.map((status, index) => ({
      id: catalog.scenarios[index].id, status, durationMs: 10,
      attempts: status === 'interrupted' ? [] : [{ retry: 0, status, durationMs: 10, startedAt: '2026-11-08T00:00:00Z', errors: [], attachments: [] }]
    })) };
}

function setup(statuses) {
  const config = configuration();
  const evidence = report(statuses);
  const state = publication.newState(config);
  const execution = publication.prepare(state, catalog, evidence, config);
  return { config, evidence, state, execution };
}

function normalizeReceipt(state, executionId, operationId, properties) {
  const operation = state.executions[executionId].operations[operationId];
  return { executionId, operationId, identity: operation.identity,
    source: operation.kind === 'defect' ? 'atlassian-rovo' : 'testrail', ...properties };
}

function reconcileEmpty(state, executionId, operationId) {
  publication.receipt(state, executionId, normalizeReceipt(state, executionId, operationId,
    { kind: 'reconciliation', complete: true, matches: [] }));
}

function confirm(state, executionId, operationId, remoteId) {
  reconcileEmpty(state, executionId, operationId);
  const intent = publication.begin(state, executionId, operationId);
  const kind = state.executions[executionId].operations[operationId].kind;
  const context = kind === 'case' ? { sectionId: intent.section_id, scenarioId: intent.refs }
    : kind === 'run' ? { projectId: intent.project_id, caseIds: intent.case_ids }
      : kind === 'defect' ? { projectKey: intent.projectKey }
        : { runId: intent.run_id, caseId: intent.case_id, statusId: intent.status_id, defects: intent.defects || '' };
  const value = normalizeReceipt(state, executionId, operationId, { kind: 'write', outcome: 'confirmed', remoteId, context });
  publication.receipt(state, executionId, value);
  return value;
}

test('first execution imports definitions before creating the selected run and publishing results', () => {
  const { state, evidence, execution } = setup(['passed']);
  assert.throws(() => publication.begin(state, evidence.executionId, `run:${evidence.executionId}`), /Reconcile/);
  const caseReceipt = confirm(state, evidence.executionId, 'case:OHRM-AUTH-001', 101);
  assert.equal(execution.operations['case:OHRM-AUTH-001'].intent.custom_steps_separated.length, 2);
  assert.equal(execution.completed, false);
  publication.receipt(state, evidence.executionId, caseReceipt);
  assert.throws(() => publication.begin(state, evidence.executionId, 'case:OHRM-AUTH-001'), /Reconcile/);
  confirm(state, evidence.executionId, `run:${evidence.executionId}`, 201);
  confirm(state, evidence.executionId, 'result:OHRM-AUTH-001', 301);
  assert.equal(execution.completed, true);
});

test('repeat execution reuses confirmed cases but creates a distinct execution run', () => {
  const { state, evidence, config } = setup(['passed']);
  confirm(state, evidence.executionId, 'case:OHRM-AUTH-001', 101);
  const next = report(['passed'], 'execution-0002');
  const execution = publication.prepare(state, catalog, next, config);
  assert.equal(execution.operations['case:OHRM-AUTH-001'].remoteId, 101);
  assert.equal(execution.operations['run:execution-0002'].status, 'pending');
  assert.throws(() => publication.receipt(state, next.executionId, normalizeReceipt(state, next.executionId, 'run:execution-0002',
    { kind: 'reconciliation', complete: true, matches: [{ identity: 'orangehrm:execution:execution-0002', remoteId: 1 }, { remoteId: 2 }] })), /Ambiguous/);
});

test('final failure requires a fresh Jira defect for each execution and links its key to the result', () => {
  const { state, evidence, execution, config } = setup(['failed']);
  confirm(state, evidence.executionId, 'case:OHRM-AUTH-001', 101);
  confirm(state, evidence.executionId, `run:${evidence.executionId}`, 201);
  assert.throws(() => reconcileEmpty(state, evidence.executionId, 'result:OHRM-AUTH-001'), /prerequisites/);
  confirm(state, evidence.executionId, 'defect:OHRM-AUTH-001', 'QA-42');
  assert.equal(publication.requestIntent(state, evidence.executionId, 'result:OHRM-AUTH-001').defects, 'QA-42');
  confirm(state, evidence.executionId, 'result:OHRM-AUTH-001', 301);
  assert.equal(execution.completed, true);
  const next = publication.prepare(state, catalog, report(['failed'], 'execution-0002'), config);
  assert.equal(next.operations['defect:OHRM-AUTH-001'].status, 'pending');
  assert.notEqual(next.operations['defect:OHRM-AUTH-001'].identity, execution.operations['defect:OHRM-AUTH-001'].identity);
});

test('retry recovery retains failed attempts but never plans a Jira defect', () => {
  const { state, config, evidence } = setup(['passed']);
  evidence.scenarios[0].attempts.unshift({ ...evidence.scenarios[0].attempts[0], status: 'failed' });
  evidence.scenarios[0].attempts[1].retry = 1;
  const execution = publication.prepare(publication.newState(config), catalog, evidence, config);
  assert.ok(!execution.operations['defect:OHRM-AUTH-001']);
  assert.match(execution.operations['result:OHRM-AUTH-001'].intent.comment, /Attempt 0: failed/);
  assert.equal(execution.operations['result:OHRM-AUTH-001'].intent.status_id, 11);
  assert.equal(Object.keys(state.cases).length, 0);
});

test('skipped and interrupted scenarios use discovered non-passing IDs and create no defects', () => {
  const { execution } = setup(['skipped', 'interrupted']);
  assert.equal(execution.operations['result:OHRM-AUTH-001'].intent.status_id, 12);
  assert.equal(execution.operations['result:OHRM-AUTH-002'].intent.status_id, 12);
  assert.equal(Object.values(execution.operations).filter(item => item.kind === 'defect').length, 0);
});

test('remote outage and failed Jira writes remain pending and block result completion', () => {
  const { state, evidence, config, execution } = setup(['failed']);
  confirm(state, evidence.executionId, 'case:OHRM-AUTH-001', 101);
  confirm(state, evidence.executionId, `run:${evidence.executionId}`, 201);
  reconcileEmpty(state, evidence.executionId, 'defect:OHRM-AUTH-001');
  publication.begin(state, evidence.executionId, 'defect:OHRM-AUTH-001');
  publication.receipt(state, evidence.executionId, normalizeReceipt(state, evidence.executionId, 'defect:OHRM-AUTH-001', { kind: 'write', outcome: 'failed' }));
  const resumed = publication.prepare(state, catalog, evidence, config);
  assert.equal(resumed.operations['case:OHRM-AUTH-001'].status, 'confirmed');
  assert.equal(resumed.operations['defect:OHRM-AUTH-001'].status, 'pending');
  assert.equal(execution.completed, false);
  assert.throws(() => publication.begin(state, evidence.executionId, 'defect:OHRM-AUTH-001'), /Reconcile/);
});

test('timeout after submission is reconciled before retry and recovers a known remote write', () => {
  const { state, evidence, config, execution } = setup(['passed']);
  const operationId = 'case:OHRM-AUTH-001';
  reconcileEmpty(state, evidence.executionId, operationId);
  publication.begin(state, evidence.executionId, operationId);
  publication.prepare(state, catalog, evidence, config);
  assert.equal(execution.operations[operationId].status, 'ambiguous');
  assert.throws(() => publication.begin(state, evidence.executionId, operationId), /Reconcile/);
  assert.throws(() => publication.receipt(state, evidence.executionId, normalizeReceipt(state, evidence.executionId, operationId,
    { kind: 'reconciliation', complete: false, matches: [] })), /complete identity search/);
  publication.receipt(state, evidence.executionId, normalizeReceipt(state, evidence.executionId, operationId,
    { kind: 'reconciliation', complete: true, matches: [{ identity: execution.operations[operationId].identity, remoteId: 101,
      context: { sectionId: 9, scenarioId: 'OHRM-AUTH-001' } }] }));
  assert.equal(execution.operations[operationId].status, 'confirmed');
  assert.equal(execution.operations[operationId].submissions, 1);
});

test('unknown, ambiguous and misleading TestRail status mappings are rejected', () => {
  const config = configuration();
  config.testrail.statusMap.passed = 'blocked';
  config.testrail.statusMap.failed = 'passed';
  assert.throws(() => publication.validateConfiguration(config), /Passing status must map/);
  config.testrail.statusMap.passed = 'passed';
  config.testrail.statusMap.failed = 'failed';
  config.testrail.statusMap.skipped = 'unknown';
  assert.throws(() => publication.validateConfiguration(config), /Unknown/);
  config.testrail.statusMap.skipped = 'passed';
  assert.throws(() => publication.validateConfiguration(config), /Non-passing/);
  config.testrail.statusMap.skipped = 'blocked';
  config.discovery.statuses.push({ id: 25, name: 'passed' });
  assert.throws(() => publication.validateConfiguration(config), /ambiguous/);
});

test('report correspondence rejects duplicate, unknown, forged passing and unsafe evidence', () => {
  const evidence = report();
  evidence.scenarios.push(structuredClone(evidence.scenarios[0]));
  assert.throws(() => publication.validateExecution(catalog, evidence), /Duplicate/);
  evidence.scenarios.pop();
  evidence.scenarios[0].id = 'UNKNOWN';
  assert.throws(() => publication.validateExecution(catalog, evidence), /uncatalogued/);
  evidence.scenarios[0].id = 'OHRM-AUTH-001';
  evidence.scenarios[0].attempts[0].status = 'failed';
  assert.throws(() => publication.validateExecution(catalog, evidence), /Final status/);
  evidence.scenarios[0].attempts[0].status = 'passed';
  evidence.scenarios[0].attempts[0].attachments.push({ name: 'trace', contentType: 'application/zip', path: '../secret.zip' });
  assert.throws(() => publication.validateExecution(catalog, evidence), /Unsafe/);
});

test('receipt IDs, integration source, destination and Jira result linkage are validated', () => {
  const { state, evidence } = setup(['passed']);
  reconcileEmpty(state, evidence.executionId, 'case:OHRM-AUTH-001');
  publication.begin(state, evidence.executionId, 'case:OHRM-AUTH-001');
  const value = normalizeReceipt(state, evidence.executionId, 'case:OHRM-AUTH-001',
    { kind: 'write', outcome: 'confirmed', remoteId: 101, context: { sectionId: 1, scenarioId: 'OHRM-AUTH-001' } });
  assert.throws(() => publication.receipt(state, evidence.executionId, value), /destination/);
  value.context.sectionId = 9;
  value.remoteId = '';
  assert.throws(() => publication.receipt(state, evidence.executionId, value), /identifier/);
  value.remoteId = 101;
  value.source = 'atlassian-rovo';
  assert.throws(() => publication.receipt(state, evidence.executionId, value), /wrong MCP/);
});

test('secret redaction strips secret properties, environment values, bearer tokens and URLs', () => {
  const value = publication.redact({ password: 'private', nested: { apiKey: 'private' },
    message: 'private Bearer credential password=hidden https://user:pass@example.com' }, ['private']);
  assert.ok(!JSON.stringify(value).includes('private'));
  assert.ok(!JSON.stringify(value).includes('credential'));
  assert.ok(!JSON.stringify(value).includes('hidden'));
  assert.ok(!JSON.stringify(value).includes('user:pass'));
});

test('atomic state persistence survives a partial execution and prevents concurrent updates', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orangehrm-state-'));
  const filePath = path.join(directory, 'state.json');
  try {
    const { config, evidence } = setup(['passed']);
    publication.withState(filePath, publication.newState(config), state => {
      publication.prepare(state, catalog, evidence, config);
      confirm(state, evidence.executionId, 'case:OHRM-AUTH-001', 101);
      assert.throws(() => publication.withState(filePath, publication.newState(config), () => {}), /locked/);
    });
    publication.withState(filePath, publication.newState(config), state => {
      const execution = publication.prepare(state, catalog, evidence, config);
      assert.equal(execution.operations['case:OHRM-AUTH-001'].remoteId, 101);
      assert.equal(execution.completed, false);
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('changed destinations, evidence and case definitions cannot silently reuse known writes', () => {
  const { state, evidence, config } = setup(['passed']);
  confirm(state, evidence.executionId, 'case:OHRM-AUTH-001', 101);
  const changedConfig = structuredClone(config);
  changedConfig.testrail.sectionId = 999;
  assert.throws(() => publication.prepare(state, catalog, evidence, changedConfig), /destination changed/);
  const changedReport = structuredClone(evidence);
  changedReport.scenarios[0].durationMs = 1000;
  assert.throws(() => publication.prepare(state, catalog, changedReport, config), /report changed/);
  const changedCatalog = structuredClone(catalog);
  changedCatalog.scenarios[0].title = 'New definition';
  assert.throws(() => publication.prepare(state, changedCatalog, evidence, config), /catalog changed/);
  assert.throws(() => publication.prepare(state, changedCatalog, report(['passed'], 'execution-0002'), config), /definition changed/);
});

test('reporter checkpoints retry evidence, preserves attachments and keeps unfinished retries interrupted', () => {
  const Reporter = require('../../reporters/regression-reporter');
  const originalDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orangehrm-reporter-'));
  try {
    process.chdir(directory);
    const reporter = new Reporter();
    const selectedTest = { title: `${catalog.scenarios[0].id} ${catalog.scenarios[0].title}`, retries: 1 };
    reporter.onBegin({}, { allTests: () => [selectedTest] });
    const reportPath = path.join(reporter.directory, 'report.json');
    assert.equal(JSON.parse(fs.readFileSync(reportPath)).scenarios[0].status, 'interrupted');
    fs.mkdirSync('test-results');
    fs.writeFileSync('test-results/evidence.png', 'fake pixels');
    reporter.onTestEnd(selectedTest, { retry: 0, status: 'failed', duration: 10, startTime: new Date(),
      errors: [{ message: 'password=private token=sensitive' }], attachments: [
        { name: 'screenshot', contentType: 'image/png', path: path.resolve('test-results/evidence.png') },
        { name: 'outside', contentType: 'text/plain', path: path.join(os.tmpdir(), 'outside.txt') }
      ] });
    let evidence = JSON.parse(fs.readFileSync(reportPath));
    assert.equal(evidence.scenarios[0].status, 'interrupted');
    assert.equal(evidence.scenarios[0].attempts[0].attachments.length, 1);
    assert.ok(fs.existsSync(evidence.scenarios[0].attempts[0].attachments[0].path));
    assert.ok(!JSON.stringify(evidence).includes('private'));
    reporter.onTestEnd(selectedTest, { retry: 1, status: 'passed', duration: 10, startTime: new Date(), errors: [], attachments: [] });
    reporter.onEnd({ status: 'passed' });
    evidence = JSON.parse(fs.readFileSync(reportPath));
    publication.validateExecution(catalog, evidence);
    assert.equal(evidence.scenarios[0].status, 'passed');
    assert.equal(evidence.scenarios[0].attempts.length, 2);
    assert.equal(evidence.publication, 'pending');
  } finally {
    process.chdir(originalDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reporter skipped outcomes remain non-passing and discovery never overwrites latest execution', () => {
  const Reporter = require('../../reporters/regression-reporter');
  const originalDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orangehrm-skipped-'));
  try {
    process.chdir(directory);
    const reporter = new Reporter();
    const selectedTest = { title: `${catalog.scenarios[0].id} ${catalog.scenarios[0].title}`, retries: 1 };
    reporter.onBegin({}, { allTests: () => [selectedTest] });
    reporter.onTestEnd(selectedTest, { retry: 0, status: 'skipped', duration: 0, startTime: new Date(), errors: [], attachments: [] });
    reporter.onEnd({ status: 'passed' });
    publication.validateExecution(catalog, reporter.report);
    assert.equal(reporter.report.status, 'interrupted');
    const latest = fs.readFileSync('artifacts/latest.json', 'utf8');
    process.argv.push('--list');
    try {
      const listing = new Reporter();
      listing.onBegin({}, { allTests: () => [selectedTest] });
      listing.onEnd({ status: 'passed' });
      assert.equal(fs.readFileSync('artifacts/latest.json', 'utf8'), latest);
    } finally { process.argv.pop(); }
  } finally {
    process.chdir(originalDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unfinished reports cannot be prepared even when all scenarios are interrupted', () => {
  const evidence = report(['interrupted']);
  evidence.endedAt = null;
  evidence.status = 'interrupted';
  assert.throws(() => publication.validateExecution(catalog, evidence), /finalized before preparation/);
  assert.throws(() => publication.prepare(publication.newState(configuration()), catalog, evidence, configuration()), /finalized before preparation/);
});

test('unconfigured local synchronization is explicitly pending and finalization preserves completed failures', () => {
  const { run } = require('../../scripts/sync-results');
  const originalDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orangehrm-offline-'));
  try {
    process.chdir(directory);
    fs.mkdirSync('tests');
    fs.writeFileSync('tests/catalog.json', JSON.stringify(catalog));
    publication.writeAtomic('artifacts/execution-0001/report.json', report());
    publication.writeAtomic('artifacts/latest.json', { report: 'artifacts/execution-0001/report.json' });
    const dryRun = run(['--dry-run']);
    assert.equal(dryRun.publication, 'pending');
    assert.equal(dryRun.writesPerformed, 0);
    assert.throws(() => run(['--prepare']), /Publishing pending/);
    const evidence = report(['failed', 'interrupted']);
    evidence.endedAt = null;
    evidence.status = 'interrupted';
    publication.writeAtomic('artifacts/execution-0001/report.json', evidence);
    run(['--finalize-interrupted']);
    const finalized = JSON.parse(fs.readFileSync('artifacts/execution-0001/report.json'));
    assert.equal(finalized.scenarios[0].status, 'failed');
    assert.equal(finalized.scenarios[1].status, 'interrupted');
    const execution = publication.prepare(publication.newState(configuration()), catalog, finalized, configuration());
    assert.ok(execution.operations['defect:OHRM-AUTH-001']);
    assert.ok(!execution.operations['defect:OHRM-AUTH-002']);
  } finally {
    process.chdir(originalDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local command protocol checkpoints writes, resumes receipts and exits unsuccessfully until complete', () => {
  const { run } = require('../../scripts/sync-results');
  const { spawnSync } = require('node:child_process');
  const script = path.resolve(__dirname, '../../scripts/sync-results.js');
  const originalDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orangehrm-command-'));
  try {
    process.chdir(directory);
    fs.mkdirSync('tests');
    fs.writeFileSync('tests/catalog.json', JSON.stringify(catalog));
    publication.writeAtomic('artifacts/execution-0001/report.json', report());
    publication.writeAtomic('artifacts/latest.json', { report: 'artifacts/execution-0001/report.json' });
    publication.writeAtomic('config/integrations.json', configuration());
    const prepared = run(['--prepare']);
    assert.equal(prepared.writesPerformed, 0);
    assert.equal(spawnSync(process.execPath, [script, '--check'], { cwd: directory }).status, 1);
    for (const [operationId, remoteId, context] of [
      ['case:OHRM-AUTH-001', 101, { sectionId: 9, scenarioId: 'OHRM-AUTH-001' }],
      ['run:execution-0001', 201, { projectId: 7, caseIds: [101] }],
      ['result:OHRM-AUTH-001', 301, { runId: 201, caseId: 101, statusId: 11, defects: '' }]
    ]) {
      const state = JSON.parse(fs.readFileSync(prepared.state));
      const empty = normalizeReceipt(state, 'execution-0001', operationId, { kind: 'reconciliation', complete: true, matches: [] });
      publication.writeAtomic('config/receipts/receipt.json', empty);
      run(['--receipt', 'config/receipts/receipt.json']);
      run(['--begin', operationId]);
      const checkpointed = JSON.parse(fs.readFileSync(prepared.state));
      assert.equal(checkpointed.executions['execution-0001'].operations[operationId].status, 'submitting');
      const value = normalizeReceipt(checkpointed, 'execution-0001', operationId, { kind: 'write', outcome: 'confirmed', remoteId, context });
      publication.writeAtomic('config/receipts/receipt.json', value);
      run(['--receipt', 'config/receipts/receipt.json']);
    }
    const checked = spawnSync(process.execPath, [script, '--check'], { cwd: directory, encoding: 'utf8' });
    assert.equal(checked.status, 0);
    assert.equal(JSON.parse(checked.stdout).publication, 'complete');
    assert.equal(JSON.parse(checked.stdout).writesPerformed, 0);
  } finally {
    process.chdir(originalDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});