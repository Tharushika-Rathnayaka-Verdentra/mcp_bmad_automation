---
title: 'OrangeHRM Regression Automation with BMad and MCP'
type: feature
ticket: ''
created: '2026-11-08'
status: built
baseline_revision: '3fdc4959c724640be97c29f5c8eb3dfaaac8d6c6'
route: full
route_source: auto
risk: high
review: quick
review_source: pinned
lenses_ran: [quick]
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent - do not modify unless human renegotiates">

## Intent

**Problem:** No regression harness exists. Build Playwright tests, publish case definitions and results to TestRail, and create Jira defects for failures.

**Approach:** Use stable scenario IDs, local execution, and MCP publishing: BMad/Playwright MCP for authoring, TestRail MCP for cases/results, Atlassian Rovo MCP for defects. Preserve this standalone project.

**Decisions:** Login/session only; BMad-agent-driven publishing. Use community-maintained `@uarlouski/testrail-mcp-server@3.3.1`. Create a fresh defect per failed test per execution; resume without duplicate issues. Configure destinations and authentication before publishing. No synthetic defects without permission.

## Boundaries & Constraints

**Always:** Use the supplied OrangeHRM demo URL. Store steps, expectations, identifiers, and final status. Import cases before results. Preserve local evidence and report incomplete publishing. Keep credentials out of source, prompts, reports, and commits. Link Jira keys to TestRail results.

**Never:** Replace the specified MCP integrations silently with direct REST or the existing BMad Jira CLI configuration. Assume OAuth login is already complete. Claim remote publishing succeeded without returned remote identifiers. Create defects for passing, skipped, or retry-recovered tests. Change installed BMad workflow files or delete existing project files.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First execution | New scenario IDs | Create cases with steps and expected outcomes, create run, publish results | Persist successful identifiers before next write |
| Repeat execution | Existing scenario IDs | Reuse cases; create a distinct execution run | Reject ambiguous case matches |
| Final failure | Exhausted retries | Create new defect for this test/execution; link issue key to result | Failed Jira write remains pending, not completed |
| Retry recovery | Failure then pass | Publish final outcome and retry evidence; no defect | Retain attempt history locally |
| Skipped/interrupted | Incomplete execution | Explicit non-passing status using discovered TestRail status IDs | Never convert missing results to passed |
| Remote outage | MCP error or authorization failure | Local report retained; synchronization exits unsuccessfully | Resume pending operations without duplicating known writes |
| Ambiguous remote write | Timeout after submission | Reconcile by stable identity before retry | Stop for reconciliation if server cannot resolve ambiguity |

</frozen-after-approval>

## Code Map

- `package.json`: CommonJS, no test dependencies, failing placeholder script; reuse it.
- `_bmad/scripts/render_skill.py`: BMad workflow entry point; preserve installation.
- `.agents/skills/bmad-qa-generate-e2e-tests/SKILL.md`: Authoring command to invoke after harness setup.
- No test harness or workspace MCP configuration exists. Existing BMad Jira ticketing is a CLI template, not Rovo.
- Playwright MCP reached OrangeHRM; authenticated pages remain uninspected. TestRail/Jira tools were not discovered.
- Verified official transports: `@playwright/mcp` stdio; Atlassian `https://mcp.atlassian.com/v2/mcp` with OAuth.
- Selected TestRail package supports cases, runs, results, attachments, and metadata discovery over stdio. Recent releases and delete controls favor it over older `mcp-testrail`; this is not a security audit. References: https://uarlouski.github.io/testrail-mcp-server/ and https://github.com/uarlouski/testrail-mcp-server/releases/tag/v3.3.1.

## Tasks & Acceptance

**Execution:**
- [x] `package.json`, `package-lock.json`, `.gitignore`, `playwright.config.js`: Add pinned tooling, local run/verification scripts, isolated browser contexts, bounded retries, and artifact exclusions.
- [x] `tests/catalog.json`, `tests/orangehrm.spec.js`: Use Playwright MCP and BMad to author login, invalid credentials, required fields, logout, and unauthenticated session protection tests with stable IDs and case definitions. No data mutations.
- [x] `reporters/regression-reporter.js`: Collect final statuses, attempt evidence, timing, and sanitized attachment paths into a durable machine-readable report, including interrupted runs.
- [x] `.vscode/mcp.json`, `config/integrations.example.json`: Configure pinned Playwright/TestRail servers and official Rovo endpoint, secure credential references, and required destinations. Disable TestRail deletes and unused writes. Validate schemas before publishing.
- [x] `scripts/sync-results.js`, `lib/publication-state.js`: Prepare/validate publishing operations and persist remote IDs. BMad invokes MCP tools for case import, run creation, results, and defects; never pretend the local command itself publishes.
- [x] `tests/unit/integrations.test.js`: Exercise publication-state transitions with fake MCP receipts: partial writes, unknown statuses, duplicate prevention, retries, and secret redaction.
- [x] `.github/prompts/orangehrm-regression.prompt.md`, `README.md`: Provide a BMad-based author/run/publish command and document installation, OAuth, TestRail authentication, offline mode, and remote validation. Follow the agent-customization skill when authoring the prompt.

**Acceptance Criteria:**
- Given the approved scope, when the BMad authoring command runs, then executable Playwright scenarios and corresponding structured case definitions are produced.
- Given authenticated servers and selected destinations, when an execution is synchronized, then every selected scenario has a TestRail case and a recorded outcome in the execution run.
- Given a final failed test, when synchronization completes, then a Jira defect exists with reproduction steps and evidence references and its key appears on the TestRail result.
- Given unavailable credentials, when tests run locally, then artifacts are retained and publishing is explicitly pending rather than reported successful.
- Given a successful partial synchronization, when resumed, then already confirmed case, run, result, and issue operations are not repeated.

## Implementation Notes

- Local implementation completed on 2026-11-08. Pinned Playwright Test 1.65.0, Playwright MCP 0.0.84, Ajv 8.20.0, and the required TestRail MCP 3.3.1. Installed BMad files and the frozen intent were not manually modified.
- Invoked BMad build and QA workflow rendering; the reusable author mode preserves QA's human checkpoints. Playwright MCP inspected the live login/dashboard/logout path without returning credentials. The five catalogued scenarios perform no application data mutations.
- Reporter and publication state use fsynced atomic checkpoints. Interrupted/retry-recovered scenarios retain attempt evidence; confirmed receipts survive resume. Submission ambiguity blocks blind retries. Catalog, configuration and report content are frozen per prepared execution.
- Verification: `npm run test:unit` passed 17 tests, covering every I/O matrix row plus reporter/offline/CLI behavior. `npx playwright test --list` discovered all five scenarios. `npm run test:regression` passed all five twice (50.8s and 47.2s). `npm run verify` passed unit tests, discovery and dry-run. Dependency installation audit reported zero vulnerabilities.
- Real reports: `artifacts/1c0dc08c-2e8d-443d-b453-3bce31438bce/report.json` and `artifacts/375b048b-3c0a-490c-8ca9-cdddacfbbd88/report.json`. Final dry-run validated the second execution, reported publication pending and zero remote writes, and planned no Jira defects because every scenario passed.
- Live acceptance remains incomplete: no authenticated TestRail/Rovo tools or selected destinations were available. No cases, runs, results or Jira defects were remotely created. Remote schema/hierarchy validation and returned identifiers must be verified using the documented MCP protocol. Jira failure/linkage behavior was verified with mocks only; no synthetic defects were created.
- Risks: shared demo availability; raw local traces/screenshots may contain sensitive session data and must be reviewed before sharing; TestRail's pinned third-party package is not security-audited here; loss of local publication state or incomplete/uncertain remote identity search requires manual reconciliation. Plan remains in-progress until live acceptance is established.
- Parent verification: all five scenarios passed in 39.5s; report `artifacts/db03b5a5-7605-44a0-b592-1d25daa93ccd/report.json`. Review patches passed 18 unit tests. Remote writes remain zero.
- Final verification after review repairs: 18 unit tests passed, all five scenarios discovered and passed in 39.4s; `artifacts/bb422bb6-fbb5-4b32-8fcb-1745f203aec3/report.json`. Dry-run passed with publication pending and zero writes. Built denotes the local implementation; live acceptance is deferred, not satisfied.

## Plan Change Log

## Review Triage Log

- Quick review: 3 high, 1 medium, 0 low, 0 false, 0 maybe-false.
| Finding | Verdict | Route | Verified Evidence / Action |
| --- | --- | --- | --- |
| Finalization overwrites completed failures | high | patch | The finalizer changed all statuses to interrupted, suppressing defects for exhausted failures. Removed that overwrite; unit coverage verifies preservation and defect planning. |
| Unfinished reports can be frozen before finalization | high | patch | Initial interrupted checkpoints passed validation and later failed reportHash checks. Require endedAt before preparation; unit coverage rejects unfinished reports. |
| Swapped status mappings can publish failures as Passed | high | patch | Relative ID comparison allowed local passed=blocked and failed=passed. Require the passed mapping to resolve canonical Passed; swapped-map regression passes. |
| Live publishing acceptance lacks remote evidence | medium | defer | No authenticated servers or destinations existed before implementation. Offline checks cannot establish remote acceptance; publication remains pending until external setup and live validation. |

## Design Notes

Playwright Test runs scenarios; MCP handles agent tools and publication. Discover tool schemas, TestRail statuses, and Jira required fields. Live acceptance requires authenticated servers and selected destinations.

## Verification

- `npm run test:unit`: Publication-state and failure-path checks pass without credentials or external writes.
- `npx playwright test --list`: Selected scenarios are discoverable and every scenario has a catalog entry.
- `npm run test:regression`: Selected OrangeHRM scenarios execute and emit reports; genuine failures stay failures.
- `npm run sync:dry-run`: Validate report/catalog correspondence and planned remote operations without writing.
- Live MCP acceptance: Import cases, publish a real execution, and verify remote IDs. Verify Jira linkage for genuine failures; use mocks otherwise. Authentication/destinations are prerequisites.
