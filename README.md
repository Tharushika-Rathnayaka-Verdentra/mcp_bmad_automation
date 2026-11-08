# OrangeHRM Regression Automation

Standalone CommonJS Playwright harness for the OrangeHRM demo at
https://opensource-demo.orangehrmlive.com. Scope is login/session only: valid
login, invalid credentials, required fields, logout, and unauthenticated dashboard
protection. The approved plan is in [_bmad-output/plan-orangehrm-regression-automation.md](_bmad-output/plan-orangehrm-regression-automation.md).

## Local Execution

Use Node.js 20+ and npm. Install the locked dependencies and Chromium:

```powershell
npm ci
npx playwright install chromium
npm run test:unit
npx playwright test --list
npm run test:regression
npm run sync:dry-run
```

Local execution needs no TestRail or Jira credentials. Fresh browser contexts are
provided by Playwright for each scenario, with one worker and at most one retry.
Tests obtain the publicly displayed demo credentials at runtime. Optional
`ORANGEHRM_USERNAME`/`ORANGEHRM_PASSWORD` environment overrides must never be
entered into chat or committed. The demo is shared and can be slow/unavailable;
failures are retained, not converted into passes or expected failures.

Each execution has a UUID directory under `artifacts/`, with `report.json` and
preserved retry attachments. `artifacts/latest.json` points to the newest real
execution; discovery does not replace it. Reports checkpoint selected scenarios
as interrupted before execution, and each attempt before the next. A final
passing retry retains failed-attempt evidence but creates no Jira defect.
Skipped/interrupted scenarios have explicit non-passing publication statuses.
`--grep OHRM-AUTH-001` can select a subset; only selected scenarios are published.

The JSON report contains sanitized summaries, not raw error messages. Trace ZIPs,
screenshots, terminal output and MCP snapshots are restricted local evidence and
may contain credentials, cookies, tokens, or personal data. They are excluded
from source control and are never automatically uploaded. Review/redact evidence
before sharing; local file references are not remotely accessible attachments.
Node file permissions are best-effort on Windows: secure the workspace with OS
ACLs. Publication state is also excluded from source control; back it up securely
because losing confirmed IDs requires remote reconciliation.

If a process is killed before the reporter finishes, confirm it is no longer
running and finalize its report. Completed outcomes are preserved; unfinished
scenarios remain interrupted, and attempt history is retained:

```powershell
node scripts/sync-results.js --finalize-interrupted --report artifacts/EXECUTION/report.json
```

## BMad Command

In VS Code Copilot agent chat invoke `/orangehrm-regression run`,
`/orangehrm-regression author`, or `/orangehrm-regression publish REPORT_PATH`.
The workspace [prompt](.github/prompts/orangehrm-regression.prompt.md) loads the
approved plan and invokes the installed BMad QA skill for authoring with
Playwright MCP. Authoring obeys the skill's human scenario checkpoints. Run mode
is local/offline and does not publish. Publish mode uses agent MCP calls only.
The local synchronizer does not call remote REST, MCP or the BMad Jira CLI.

## MCP Setup

Open [.vscode/mcp.json](.vscode/mcp.json) in VS Code and use its server Start
controls (or `MCP: List Servers`). Trust only the servers you intend to run:

- Playwright: pinned `@playwright/mcp@0.0.84`, stdio, headless isolated context.
- TestRail: community-maintained `@uarlouski/testrail-mcp-server@3.3.1`, stdio.
  Enter instance URL, account email and API key only in VS Code's input controls.
  The email/key use password inputs, not checked-in values. Enable TestRail API
  access and obtain an API key under your account settings. Deletes, case updates,
  structural mutations, alternate result writes, attachments and optional features
  are disabled. Only case creation, run creation and case-addressed results are
  needed; the agent must not use mutate_run to update existing runs.
- Atlassian Rovo: official `https://mcp.atlassian.com/v2/mcp` HTTP endpoint.
  Complete its browser OAuth flow using your Atlassian account. OAuth is not
  assumed complete and is unrelated to BMad's existing Jira CLI configuration.

Never put secrets in configuration, prompts, receipts, reports, commits or chat.
The pinned third-party TestRail package is not security-audited by this project;
review it and use a least-privilege TestRail account before trusting it.

## Destinations And Schema Discovery

Use read-only MCP tools to discover TestRail projects, suites, sections, templates,
case/result fields and statuses, and Rovo's accessible cloud IDs, Jira projects,
issue types and required fields. Ask the human to choose the destination.
Populate the ignored `config/integrations.json` using the structure in
[config/integrations.example.json](config/integrations.example.json). The example
deliberately fails publishing validation until required IDs and discovery are
provided; it is not a configured destination or a source of status IDs.

Record discovery time, actual status IDs/names, field names, required fields and
schema validation. Choose a steps template compatible with a separated array of
`content` and `expected`, and provide required additional case/Jira fields in
`caseDefaults`/`fields`. Map every local status to a discovered TestRail status
name. Non-passing statuses cannot map to Passed. The agent must verify hierarchy,
template field types, all required custom fields and each actual payload against
the server's discovered JSON schemas before setting `toolSchemasValidated: true`.
Local validation is structural and does not establish authentication or remote
schema truth. Preserve the original configuration for an execution once prepared;
changes to destinations, reports or confirmed case definitions require deliberate
reconciliation rather than silent ID reuse.

## Publication Protocol

```powershell
npm run sync:dry-run -- --report artifacts/EXECUTION/report.json
npm run sync:prepare -- --report artifacts/EXECUTION/report.json
npm run sync:receipt -- config/receipts/receipt.json --report artifacts/EXECUTION/report.json
npm run sync:begin -- case:OHRM-AUTH-001 --report artifacts/EXECUTION/report.json
npm run sync:check -- --report artifacts/EXECUTION/report.json
```

Dry-run validates report/catalog correspondence and lists operations without
writes. Without destinations it explicitly reports pending. Prepare writes a
locked, atomically replaced local state file keyed by destination; it is NOT a
remote publisher. `sync:check` exits nonzero until all operations have confirmed
receipts. Always bind commands to the intended report when resuming, not latest.

The BMad agent processes dependency-ordered operations:

1. Reconcile every stable scenario identity against all cases in the chosen
   section. Reuse a unique case only after verifying matching definitions.
   Otherwise create it with preconditions, steps and expected outcomes.
2. Create one run with exactly the confirmed case IDs for this execution UUID.
3. For a final failed/timedOut test, create a fresh Jira defect with the execution
   and scenario identity, reproduction steps, expected/actual outcome and local
   evidence references. Reuse an issue only when resuming that same execution.
4. Publish each final result with its discovered status ID, timing, retry history,
   evidence references, and the confirmed Jira key for failures.

Every operation starts pending. Search by exact identity before any write; a
complete zero-match reconciliation receipt makes it ready. `sync:begin` persists
submitting BEFORE the agent invokes the MCP write. Persist the confirmed receipt
and returned ID before the next write. Resume converts unfinished submissions to
ambiguous and never blindly retries them. Failed writes remain pending and need
another identity search. Confirmed writes are not repeated.

For a timeout, search the exact identity (including all pages and completed or
archived runs). Cases use the scenario ID in refs/title; runs use execution UUID
in name/description; Jira uses the exact marker in description within the project;
results use the marker in comment on the run's case. Resolve the per-run test ID
with `query_test` before `get_results`. Zero matches is safe only if the server
can establish absence; permission limits, eventual consistency, or incomplete
search require stopping for manual reconciliation. Multiple matches also stop.

### Sanitized Receipts

Receipts are a normalized projection of real MCP responses, not raw responses
or fabricated identifiers. Store only the keys shown here in the ignored receipts
directory. The `identity` must exactly match prepare's output. Complete
reconciliation, with zero matches:

```json
{
  "executionId": "EXECUTION-UUID",
  "operationId": "case:OHRM-AUTH-001",
  "identity": "orangehrm:OHRM-AUTH-001",
  "source": "testrail",
  "kind": "reconciliation",
  "complete": true,
  "matches": []
}
```

A successful case creation receipt (IDs below are examples, never production
evidence):

```json
{
  "executionId": "EXECUTION-UUID",
  "operationId": "case:OHRM-AUTH-001",
  "identity": "orangehrm:OHRM-AUTH-001",
  "source": "testrail",
  "kind": "write",
  "outcome": "confirmed",
  "remoteId": 123,
  "context": { "sectionId": 9, "scenarioId": "OHRM-AUTH-001" }
}
```

For a unique reconciliation match, supply one object with `identity`, `remoteId`,
and `context` inside `matches`. Context is validated by operation kind:

| Kind | Source | Required Context |
| --- | --- | --- |
| case | testrail | sectionId, scenarioId |
| run | testrail | projectId, caseIds (same selected order) |
| defect | atlassian-rovo | projectKey; remoteId is the returned Jira key |
| result | testrail | runId, caseId, statusId, defects (confirmed key or empty) |

A known rejection uses `kind: "write", outcome: "failed"`; a timeout/lost response
uses `outcome: "ambiguous"`, without a remote ID. Both keep publishing incomplete.
Never include raw error content or credentials in receipts. Read back all remote
entities through MCP and verify result/Jira linkage before claiming live success.

## Verification

`npm run verify` runs unit tests, discovery and dry-run against the latest local
report. Run regression first to create one. Unit tests use fake MCP receipts only
and cover each plan matrix row, reporter retries/interruption, unsafe paths,
secret redaction, partial persistence and concurrent-state protection. Genuine
demo failures make regression exit nonzero even when a dry-run succeeds.

Live acceptance additionally requires authenticated MCP servers, selected
destinations, real returned case/run/result IDs and verified Jira linkage for a
genuine final failure. Never create synthetic defects without permission. A
successful offline verification does not satisfy live acceptance.