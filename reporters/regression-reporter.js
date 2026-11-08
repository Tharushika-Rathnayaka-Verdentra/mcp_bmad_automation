const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const catalog = require('../tests/catalog.json');
const { writeAtomic } = require('../lib/publication-state');

function safeAttachment(attachment) {
  if (!attachment.path) return null;
  const relative = path.relative(process.cwd(), path.resolve(attachment.path));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!relative.startsWith(`test-results${path.sep}`)) return null;
  return { name: attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_'), contentType: attachment.contentType,
    path: relative.split(path.sep).join('/') };
}

class RegressionReporter {
  onBegin(config, suite) {
    if (process.argv.includes('--list')) return;
    this.executionId = randomUUID();
    this.directory = path.resolve('artifacts', this.executionId);
    fs.mkdirSync(this.directory, { recursive: true });
    this.report = {
      schemaVersion: 1, executionId: this.executionId, target: catalog.target,
      startedAt: new Date().toISOString(), endedAt: null, status: 'interrupted',
      publication: 'pending', errors: [], scenarios: []
    };
    const selected = suite.allTests();
    for (const definition of catalog.scenarios) {
      const matches = selected.filter(item => item.title.startsWith(`${definition.id} `));
      if (matches.length > 1) throw new Error(`Duplicate scenario: ${definition.id}`);
      if (matches.length === 1) this.report.scenarios.push({ id: definition.id, status: 'interrupted', durationMs: 0, attempts: [] });
    }
    if (this.report.scenarios.length !== selected.length) throw new Error('Test/catalog correspondence failed');
    this.checkpoint();
  }

  onTestEnd(test, result) {
    const entry = this.report.scenarios.find(item => test.title.startsWith(`${item.id} `));
    if (!entry) throw new Error('Uncatalogued test result');
    const attachments = result.attachments.map(safeAttachment).filter(Boolean);
    const retained = attachments.map(attachment => {
      const filename = `${entry.id}-attempt-${result.retry}-${path.basename(attachment.path)}`;
      fs.copyFileSync(path.resolve(attachment.path), path.join(this.directory, filename));
      return { ...attachment, path: `artifacts/${this.executionId}/${filename}` };
    });
    entry.attempts.push({ retry: result.retry, status: result.status, durationMs: result.duration,
      startedAt: result.startTime.toISOString(), errors: result.errors.map(() => 'Test assertion or execution failed; inspect restricted local evidence'),
      attachments: retained });
    entry.durationMs += result.duration;
    entry.status = ['failed', 'timedOut'].includes(result.status) && result.retry < test.retries
      ? 'interrupted' : result.status;
    this.checkpoint();
  }

  onError() {
    if (!this.report) return;
    this.report.errors.push('Runner error; inspect restricted local execution output');
    this.checkpoint();
  }

  onEnd(result) {
    if (!this.report) return;
    this.report.status = result.status === 'passed' && this.report.scenarios.some(item => item.status !== 'passed')
      ? 'interrupted' : result.status;
    this.report.endedAt = new Date().toISOString();
    this.checkpoint();
    console.log(`Local report: artifacts/${this.executionId}/report.json; MCP publication pending`);
  }

  checkpoint() {
    const reportPath = path.join(this.directory, 'report.json');
    writeAtomic(reportPath, this.report);
    const latest = path.resolve('artifacts/latest.json');
    writeAtomic(latest, { executionId: this.executionId, report: `artifacts/${this.executionId}/report.json` });
  }
}

module.exports = RegressionReporter;