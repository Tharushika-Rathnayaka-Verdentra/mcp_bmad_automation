const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const Ajv = require('ajv');

const ajv = new Ajv({ allErrors: true, strict: true });
const localStatuses = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'];
const positiveId = { type: 'integer', minimum: 1 };
const text = { type: 'string', minLength: 1 };
const object = properties => ({ type: 'object', properties, additionalProperties: false, required: Object.keys(properties) });
const stepSchema = object({ action: text, expected: text });
const catalogSchema = object({
  schemaVersion: { const: 1 }, target: { const: 'https://opensource-demo.orangehrmlive.com' },
  scenarios: { type: 'array', minItems: 1, items: object({
    id: { type: 'string', pattern: '^OHRM-AUTH-[0-9]{3}$' }, title: text,
    preconditions: { type: 'array', items: text }, steps: { type: 'array', minItems: 1, items: stepSchema }
  }) }
});
const attachmentSchema = object({ name: text, contentType: text, path: text });
const attemptSchema = object({
  retry: { type: 'integer', minimum: 0 }, status: { enum: localStatuses },
  durationMs: { type: 'number', minimum: 0 }, startedAt: text,
  errors: { type: 'array', items: text }, attachments: { type: 'array', items: attachmentSchema }
});
const reportSchema = object({
  schemaVersion: { const: 1 }, executionId: { type: 'string', pattern: '^[a-zA-Z0-9-]{8,80}$' },
  target: { const: 'https://opensource-demo.orangehrmlive.com' }, startedAt: text,
  endedAt: { type: ['string', 'null'] }, status: { enum: ['passed', 'failed', 'timedout', 'interrupted'] },
  publication: { const: 'pending' }, errors: { type: 'array', items: text },
  scenarios: { type: 'array', minItems: 1, items: object({
    id: text, status: { enum: localStatuses }, durationMs: { type: 'number', minimum: 0 },
    attempts: { type: 'array', items: attemptSchema }
  }) }
});
const configSchema = object({
  schemaVersion: { const: 1 },
  testrail: object({
    instanceUrl: text, projectId: positiveId, suiteId: { type: ['integer', 'null'], minimum: 1 },
    sectionId: positiveId, templateId: positiveId,
    fields: object({ preconditions: text, steps: text }),
    caseDefaults: { type: 'object' },
    statusMap: object(Object.fromEntries(localStatuses.map(status => [status, text])))
  }),
  jira: object({ cloudId: text, projectKey: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' },
    issueTypeId: text, fields: { type: 'object' } }),
  discovery: object({
    verifiedAt: text, toolSchemasValidated: { const: true },
    statuses: { type: 'array', minItems: 1, items: object({ id: positiveId, name: text }) },
    caseFieldNames: { type: 'array', items: text }, resultFieldNames: { type: 'array', items: text },
    requiredCaseFields: { type: 'array', items: text }, requiredJiraFields: { type: 'array', items: text }
  })
});

function validate(schema, value, label) {
  const check = ajv.compile(schema);
  if (!check(value)) throw new Error(`${label} schema invalid: ${check.errors.map(error => `${error.instancePath || '/'} ${error.keyword}`).join(', ')}`);
}

function hash(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function redact(value, secrets = []) {
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /password|secret|token|api.?key|authorization|username/i.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  if (typeof value !== 'string') return value;
  let sanitized = value;
  for (const secret of secrets.filter(item => typeof item === 'string' && item.length > 0).sort((first, second) => second.length - first.length)) {
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|api[_-]?key|token|secret|authorization|username)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/https:\/\/[^/@\s]+:[^/@\s]+@/gi, 'https://[REDACTED]@');
}

function validateExecution(catalog, report) {
  validate(catalogSchema, catalog, 'Catalog');
  validate(reportSchema, report, 'Report');
  if (!report.endedAt) throw new Error('Unfinished report must be finalized before preparation');
  const catalogIds = catalog.scenarios.map(item => item.id);
  const reportIds = report.scenarios.map(item => item.id);
  if (new Set(catalogIds).size !== catalogIds.length || new Set(reportIds).size !== reportIds.length) throw new Error('Duplicate scenario IDs');
  if (reportIds.some(id => !catalogIds.includes(id))) throw new Error('Report contains an uncatalogued scenario');
  for (const scenario of report.scenarios) {
    const attempts = scenario.attempts;
    if (attempts.some((attempt, index) => attempt.retry !== index)) throw new Error('Attempt history must be contiguous');
    const finalAttempt = attempts.at(-1);
    if (scenario.status !== 'interrupted' && (!finalAttempt || finalAttempt.status !== scenario.status)) throw new Error('Final status does not match attempt evidence');
    for (const attempt of attempts) {
      for (const attachment of attempt.attachments) {
        const prefix = `artifacts/${report.executionId}/`;
        if (!attachment.path.startsWith(prefix) || attachment.path.includes('..') || attachment.path.includes('\\')) throw new Error('Unsafe evidence path');
      }
    }
  }
  if (report.status === 'passed' && (report.errors.length || report.scenarios.some(item => item.status !== 'passed'))) throw new Error('Passing run has incomplete or failed evidence');
  return report;
}

function validateConfiguration(config) {
  validate(configSchema, config, 'Integration');
  const url = new URL(config.testrail.instanceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('TestRail URL must be HTTPS without credentials or query');
  if (!Number.isFinite(Date.parse(config.discovery.verifiedAt))) throw new Error('Invalid metadata discovery timestamp');
  const fields = config.testrail.fields;
  const usedCaseFields = [fields.preconditions, fields.steps, ...Object.keys(config.testrail.caseDefaults)];
  if (usedCaseFields.some(field => !config.discovery.caseFieldNames.includes(field))) throw new Error('Unknown TestRail case field');
  if (config.discovery.requiredCaseFields.some(field => !usedCaseFields.includes(field) && !['title', 'template_id', 'refs'].includes(field))) throw new Error('Missing required TestRail case fields');
  if (config.discovery.requiredJiraFields.some(field => !Object.hasOwn(config.jira.fields, field) && !['summary', 'description', 'project', 'issuetype'].includes(field))) throw new Error('Missing required Jira issue fields');
  if (Object.keys(config.testrail.caseDefaults).some(field => ['title', 'refs', 'template_id', fields.preconditions, fields.steps].includes(field))) throw new Error('Case defaults cannot override scenario identity or steps');
  if (Object.keys(config.jira.fields).some(field => ['summary', 'description', 'project', 'issuetype'].includes(field))) throw new Error('Jira fields cannot override issue identity');
  for (const field of ['status_id', 'comment', 'elapsed', 'defects']) {
    if (!config.discovery.resultFieldNames.includes(field)) throw new Error('Missing discovered TestRail result field');
  }
  const resolved = {};
  if (config.testrail.statusMap.passed.toLowerCase() !== 'passed') throw new Error('Passing status must map to TestRail Passed');
  for (const status of localStatuses) {
    const matches = config.discovery.statuses.filter(item => item.name.toLowerCase() === config.testrail.statusMap[status].toLowerCase());
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous TestRail status for ${status}`);
    resolved[status] = matches[0].id;
  }
  if (localStatuses.some(status => status !== 'passed' && resolved[status] === resolved.passed)) throw new Error('Non-passing status cannot map to Passed');
  return resolved;
}

function destinationKey(config) {
  return hash({ testrail: { instanceUrl: config.testrail.instanceUrl, projectId: config.testrail.projectId,
    suiteId: config.testrail.suiteId, sectionId: config.testrail.sectionId },
    jira: { cloudId: config.jira.cloudId, projectKey: config.jira.projectKey, issueTypeId: config.jira.issueTypeId } });
}

function newState(config) {
  return { schemaVersion: 1, destination: destinationKey(config), cases: {}, executions: {} };
}

function isFailure(scenario) {
  return ['failed', 'timedOut'].includes(scenario.status);
}

function prepare(state, catalog, report, config) {
  validateExecution(catalog, report);
  const statuses = validateConfiguration(config);
  if (state.schemaVersion !== 1 || state.destination !== destinationKey(config)) throw new Error('Publication destination changed');
  const existing = state.executions[report.executionId];
  if (existing && existing.reportHash !== hash(report)) throw new Error('Prepared report changed; retain the original execution evidence');
  if (existing && existing.catalogHash !== hash(catalog)) throw new Error('Prepared catalog changed; reconcile the original case definitions');
  if (existing && existing.configHash !== hash(config)) throw new Error('Prepared configuration changed; reconcile using the original configuration');
  const execution = existing || { reportHash: hash(report), catalogHash: hash(catalog), configHash: hash(config), operations: {}, completed: false };
  const operations = execution.operations;
  function add(id, kind, identity, dependencies, intent) {
    if (!operations[id]) operations[id] = { id, kind, identity, dependencies, intent,
      status: 'pending', remoteId: null, submissions: 0, evidence: null };
    if (operations[id].status === 'submitting') operations[id].status = 'ambiguous';
  }
  for (const scenario of report.scenarios) {
    const definition = catalog.scenarios.find(item => item.id === scenario.id);
    const definitionHash = hash(definition);
    const cached = state.cases[scenario.id];
    if (cached && cached.definitionHash !== definitionHash) throw new Error('Confirmed case definition changed; reconcile case version before reuse');
    const caseId = `case:${scenario.id}`;
    add(caseId, 'case', `orangehrm:${scenario.id}`, [], {
      section_id: config.testrail.sectionId, suite_id: config.testrail.suiteId,
      title: `[${scenario.id}] ${definition.title}`, refs: scenario.id,
      template_id: config.testrail.templateId, ...config.testrail.caseDefaults,
      [config.testrail.fields.preconditions]: definition.preconditions.join('\n'),
      [config.testrail.fields.steps]: definition.steps.map(step => ({ content: step.action, expected: step.expected })),
      definitionHash
    });
    if (cached) Object.assign(operations[caseId], { status: 'confirmed', remoteId: cached.remoteId, evidence: 'Reused confirmed scenario mapping' });
  }
  const runId = `run:${report.executionId}`;
  add(runId, 'run', `orangehrm:execution:${report.executionId}`, report.scenarios.map(item => `case:${item.id}`), {
    project_id: config.testrail.projectId, suite_id: config.testrail.suiteId,
    name: `OrangeHRM regression ${report.executionId}`, description: `orangehrm:execution:${report.executionId}`
  });
  for (const scenario of report.scenarios) {
    const definition = catalog.scenarios.find(item => item.id === scenario.id);
    const identity = `orangehrm:${report.executionId}:${scenario.id}`;
    const issueId = `defect:${scenario.id}`;
    if (isFailure(scenario)) add(issueId, 'defect', identity, [runId], {
      cloudId: config.jira.cloudId, projectKey: config.jira.projectKey, issueTypeId: config.jira.issueTypeId,
      summary: `[${scenario.id}] ${definition.title} (${report.executionId})`,
      description: [identity, `Target: ${report.target}`, `Final outcome: ${scenario.status}`,
        ...definition.preconditions, ...definition.steps.map((step, index) => `${index + 1}. ${step.action}\nExpected: ${step.expected}`),
        `Actual: final ${scenario.status} after ${scenario.attempts.length} attempt(s).`,
        `Local evidence: artifacts/${report.executionId}/report.json`,
        ...scenario.attempts.flatMap(attempt => attempt.attachments.map(item => item.path))].join('\n'),
      fields: config.jira.fields
    });
    add(`result:${scenario.id}`, 'result', identity,
      [runId, `case:${scenario.id}`, ...(isFailure(scenario) ? [issueId] : [])], {
        status_id: statuses[scenario.status],
        comment: [identity, `Final outcome: ${scenario.status}`, `Evidence: artifacts/${report.executionId}/report.json`,
          ...scenario.attempts.map(attempt => `Attempt ${attempt.retry}: ${attempt.status}, ${attempt.durationMs}ms`),
          ...scenario.attempts.flatMap(attempt => attempt.attachments.map(item => item.path))].join('\n'),
        elapsed: `${Math.max(1, Math.ceil(scenario.durationMs / 1000))}s`
      });
  }
  state.executions[report.executionId] = execution;
  refresh(execution);
  return execution;
}

function refresh(execution) {
  execution.completed = Object.values(execution.operations).every(operation => operation.status === 'confirmed');
}

function getOperation(state, executionId, operationId) {
  const execution = state.executions[executionId];
  const operation = execution?.operations[operationId];
  if (!operation) throw new Error('Unknown publication operation');
  return { execution, operation };
}

function dependenciesConfirmed(execution, operation) {
  return operation.dependencies.every(id => execution.operations[id]?.status === 'confirmed');
}

function requestIntent(state, executionId, operationId) {
  const { execution, operation } = getOperation(state, executionId, operationId);
  if (!dependenciesConfirmed(execution, operation)) throw new Error('Operation prerequisites are not confirmed');
  const intent = structuredClone(operation.intent);
  if (operation.kind === 'case') delete intent.definitionHash;
  if (operation.kind === 'run') intent.case_ids = operation.dependencies.map(id => execution.operations[id].remoteId);
  if (operation.kind === 'result') {
    intent.run_id = execution.operations[`run:${executionId}`].remoteId;
    intent.case_id = execution.operations[operation.dependencies.find(id => id.startsWith('case:'))].remoteId;
    const defect = operation.dependencies.find(id => id.startsWith('defect:'));
    if (defect) intent.defects = execution.operations[defect].remoteId;
  }
  return intent;
}

function begin(state, executionId, operationId) {
  const { operation } = getOperation(state, executionId, operationId);
  if (operation.status !== 'ready') throw new Error('Reconcile identity before submitting a pending or ambiguous operation');
  const intent = requestIntent(state, executionId, operationId);
  operation.status = 'submitting';
  operation.submissions += 1;
  return intent;
}

function validRemoteId(kind, remoteId) {
  return kind === 'defect' ? typeof remoteId === 'string' && /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/.test(remoteId)
    : Number.isSafeInteger(remoteId) && remoteId > 0;
}

function receipt(state, executionId, value) {
  const receiptSchema = {
    type: 'object', additionalProperties: false,
    required: ['executionId', 'operationId', 'identity', 'source', 'kind'],
    properties: { executionId: text, operationId: text, identity: text, source: { enum: ['testrail', 'atlassian-rovo'] },
      kind: { enum: ['reconciliation', 'write'] }, outcome: { enum: ['confirmed', 'failed', 'ambiguous'] },
      remoteId: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      matches: { type: 'array', items: { type: 'object' } }, complete: { type: 'boolean' },
      context: { type: 'object' } }
  };
  validate(receiptSchema, value, 'Receipt');
  const { execution, operation } = getOperation(state, executionId, value.operationId);
  if (value.executionId !== executionId || value.identity !== operation.identity) throw new Error('Receipt identity mismatch');
  if (value.source !== (operation.kind === 'defect' ? 'atlassian-rovo' : 'testrail')) throw new Error('Receipt came from the wrong MCP integration');
  if (operation.status === 'confirmed') {
    if (value.kind === 'write' && value.outcome === 'confirmed' && value.remoteId === operation.remoteId) return;
    throw new Error('Cannot replace a confirmed remote receipt');
  }
  if (!dependenciesConfirmed(execution, operation)) throw new Error('Receipt prerequisites are not confirmed');
  let remoteId;
  let context;
  if (value.kind === 'reconciliation') {
    if (value.complete !== true || !Array.isArray(value.matches)) throw new Error('Reconciliation must include a complete identity search');
    if (value.matches.length > 1) throw new Error('Ambiguous remote identity; manual reconciliation required');
    if (!value.matches.length) {
      operation.status = 'ready';
      operation.evidence = 'Complete remote identity search returned no match';
      return;
    }
    const match = value.matches[0];
    if (match.identity !== operation.identity) throw new Error('Reconciled identity mismatch');
    remoteId = match.remoteId;
    context = match.context;
  } else {
    if (!['submitting', 'ambiguous'].includes(operation.status)) throw new Error('Checkpoint begin before applying a write receipt');
    if (value.outcome !== 'confirmed') {
      if (!['failed', 'ambiguous'].includes(value.outcome)) throw new Error('Write receipt requires an outcome');
      operation.status = value.outcome === 'failed' ? 'pending' : 'ambiguous';
      operation.evidence = 'MCP write not confirmed; reconcile before retry';
      return;
    }
    remoteId = value.remoteId;
    context = value.context;
  }
  if (!validRemoteId(operation.kind, remoteId)) throw new Error('Receipt lacks a valid remote identifier');
  const intent = requestIntent(state, executionId, operation.id);
  if (operation.kind === 'case' && (context?.sectionId !== intent.section_id || context?.scenarioId !== intent.refs)) throw new Error('Case receipt destination or scenario mismatch');
  if (operation.kind === 'run' && (context?.projectId !== intent.project_id || hash(context?.caseIds) !== hash(intent.case_ids))) throw new Error('Run receipt destination or selection mismatch');
  if (operation.kind === 'defect' && (context?.projectKey !== intent.projectKey || !remoteId.startsWith(`${intent.projectKey}-`))) throw new Error('Defect receipt project mismatch');
  if (operation.kind === 'result' && (context?.runId !== intent.run_id || context?.caseId !== intent.case_id || context?.statusId !== intent.status_id || (context?.defects || '') !== (intent.defects || ''))) throw new Error('Result receipt outcome or Jira linkage mismatch');
  if (operation.kind === 'case') {
    const scenarioId = operation.intent.refs;
    const conflicting = Object.entries(state.cases).find(([id, cached]) => id !== scenarioId && cached.remoteId === remoteId);
    if (conflicting) throw new Error('Remote case already mapped to a different scenario');
    state.cases[scenarioId] = { remoteId, definitionHash: operation.intent.definitionHash };
  }
  operation.remoteId = remoteId;
  operation.status = 'confirmed';
  operation.evidence = 'MCP identifier and identity confirmed';
  refresh(execution);
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(`${filePath}.tmp`, 'w', 0o600);
  try {
    fs.writeFileSync(handle, JSON.stringify(value, null, 2));
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  fs.renameSync(`${filePath}.tmp`, filePath);
}

function withState(filePath, initial, callback) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch { throw new Error('Publication state locked; ensure no synchronizer is active before removing a stale lock'); }
  try {
    const state = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : initial;
    const result = callback(state);
    writeAtomic(filePath, state);
    return result;
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

module.exports = { validateExecution, validateConfiguration, destinationKey, newState, prepare,
  requestIntent, begin, receipt, isFailure, redact, hash, writeAtomic, withState };