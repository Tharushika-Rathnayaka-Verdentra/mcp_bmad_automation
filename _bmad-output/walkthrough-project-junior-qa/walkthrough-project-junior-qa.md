# Walkthrough: OrangeHRM Regression Automation — technical tour for a Junior QA Engineer

Target: the whole repository. Audience: a junior QA engineer who knows what regression tests, TestRail and Jira are, but has not seen this codebase.

Legend: `[ ]` not yet reviewed / in progress · `[x]` accepted by the reviewer. **Review complete: all 8 blocks accepted. Files left uncommitted by reviewer's choice.**

## [x] Block 1 — Intent

Diagram produced during review: [block-1-overview-diagram.md](block-1-overview-diagram.md)
Pasted verbatim from the approved plan's frozen Intent section, [plan-orangehrm-regression-automation.md](../plan-orangehrm-regression-automation.md):

> **Problem:** No regression harness exists. Build Playwright tests, publish case definitions and results to TestRail, and create Jira defects for failures.
>
> **Approach:** Use stable scenario IDs, local execution, and MCP publishing: BMad/Playwright MCP for authoring, TestRail MCP for cases/results, Atlassian Rovo MCP for defects. Preserve this standalone project.
>
> **Decisions:** Login/session only; BMad-agent-driven publishing. Use community-maintained `@uarlouski/testrail-mcp-server@3.3.1`. Create a fresh defect per failed test per execution; resume without duplicate issues. Configure destinations and authentication before publishing. No synthetic defects without permission.

Source: the plan file above (status `built`, 2026-11-08). The one piece still open is in [deferred-work.md](../deferred-work.md): live TestRail/Jira publishing was never exercised against real servers.

## [x] Block 2 — Broad strokes

This is a small Node 20 / Playwright 1.65 project with three layers: **run tests → write an evidence report → track publishing of that report to TestRail/Jira**. Nothing here calls TestRail or Jira directly; a Copilot agent does that through MCP servers, and the local code only validates and records what the agent did. Open these in order:

1. [playwright.config.js](../../playwright.config.js) — the runner settings: one worker, one retry, Chromium headless, target URL, custom reporter wired in.
2. [tests/orangehrm.spec.js](../../tests/orangehrm.spec.js) — the five executable login/session scenarios.
3. [tests/catalog.json](../../tests/catalog.json) — the human-readable test-case definitions (ID, preconditions, steps, expected) that the spec is bound to.
4. [reporters/regression-reporter.js](../../reporters/regression-reporter.js) — turns a Playwright run into `artifacts/<uuid>/report.json`.
5. [scripts/sync-results.js](../../scripts/sync-results.js) — the CLI you use to prepare, checkpoint and verify publication; backed by [lib/publication-state.js](../../lib/publication-state.js).

## [x] Block 3 — Slice: the test suite and the catalog

Mechanism: every test is identified by a stable ID `OHRM-AUTH-00N`. The ID and title live in the catalog; the spec looks the scenario up by index and names the test `"<id> <title>"` so the reporter can match results back to the catalog. Tests use role/placeholder locators, fetch the demo credentials from the page at runtime (or env overrides), and never mutate application data.

- [orangehrm.spec.js:7](../../tests/orangehrm.spec.js#L7) — `scenario(index, fn)` helper that binds a test to its catalog entry.
- [orangehrm.spec.js:12](../../tests/orangehrm.spec.js#L12) — `expectLogin` — the shared "we are on the login page, not the dashboard" assertion.
- [orangehrm.spec.js:18](../../tests/orangehrm.spec.js#L18) — `login` — reads credentials from `.orangehrm-demo-credentials`, honours `ORANGEHRM_USERNAME/PASSWORD`.
- [orangehrm.spec.js:31](../../tests/orangehrm.spec.js#L31) to [orangehrm.spec.js:72](../../tests/orangehrm.spec.js#L72) — scenarios 001–005: valid login, invalid credentials, required fields, logout, unauthenticated dashboard access.
- [catalog.json](../../tests/catalog.json) — the matching five definitions; this is what becomes the TestRail case body.
- [playwright.config.js:5](../../playwright.config.js#L5) — `workers: 1`, `retries: 1`, 45 s test timeout, trace/screenshot only on failure.

## [x] Block 4 — Slice: execution evidence (the reporter)

Mechanism: a custom Playwright reporter creates a UUID folder under `artifacts/`, writes `report.json` at start (everything `interrupted`), after each attempt, and at the end — so a killed run still leaves truthful evidence. Error messages are replaced by a fixed sanitized sentence; attachments are copied into the artifacts folder with safe names. A test that failed but still has a retry left stays `interrupted` until the retry finishes.

- [regression-reporter.js:17](../../reporters/regression-reporter.js#L17) — `onBegin`: UUID, catalog/test correspondence check, first checkpoint.
- [regression-reporter.js:37](../../reporters/regression-reporter.js#L37) — `onTestEnd`: attempt record, attachment copy, status rule for retries.
- [regression-reporter.js:7](../../reporters/regression-reporter.js#L7) — `safeAttachment`: only accepts paths inside `test-results/`.
- [regression-reporter.js:64](../../reporters/regression-reporter.js#L64) — `checkpoint`: atomic write of `report.json` and `artifacts/latest.json`.
- [artifacts/latest.json](../../artifacts/latest.json) — pointer to the newest real execution; `--list` runs never touch it.

## [x] Block 5 — Slice: the publication state machine

Mechanism: publishing is modelled as a graph of **operations** per execution — one `case:` per scenario, one `run:`, a `defect:` for each final failure, and one `result:` per scenario — each with dependencies. Every operation walks `pending → ready → submitting → confirmed` (or back to `pending`/`ambiguous`). The agent must (1) search TestRail/Jira by exact identity and record a *reconciliation receipt*, (2) call `sync:begin` *before* the MCP write, (3) record a *write receipt* with the returned remote ID. State is persisted per destination under `artifacts/publication/` with a lock and atomic writes. Report, catalog and config are hashed so nothing can change silently after preparation.

- [publication-state.js:140](../../lib/publication-state.js#L140) — `prepare`: builds the operation graph and the TestRail/Jira payload "intents".
- [publication-state.js:222](../../lib/publication-state.js#L222) — `requestIntent`: fills in remote IDs from confirmed dependencies (run gets `case_ids`, result gets `run_id`/`case_id`/`defects`).
- [publication-state.js:236](../../lib/publication-state.js#L236) — `begin`: refuses unless status is `ready`; marks `submitting`.
- [publication-state.js:249](../../lib/publication-state.js#L249) — `receipt`: validates receipt schema, source, dependency state, remote ID format and that the receipt context matches the intent.
- [publication-state.js:86](../../lib/publication-state.js#L86) — `validateExecution`: report ↔ catalog correspondence, contiguous attempts, no forged "passed".
- [publication-state.js:107](../../lib/publication-state.js#L107) — `validateConfiguration`: HTTPS-only URL, discovered field/status names, "non-passing can never map to Passed".
- [sync-results.js:9](../../scripts/sync-results.js#L9) — the CLI modes `--dry-run | --prepare | --begin | --receipt | --check | --finalize-interrupted`; `--check` exits 1 until every operation is confirmed.

## [x] Block 6 — Slice: MCP integration, destinations and secret hygiene

Mechanism: the real remote work happens through three MCP servers declared for VS Code; the agent prompt tells Copilot how to use them. Credentials are typed only into VS Code password inputs or an OAuth browser flow. The TestRail server is deliberately restricted (no deletes, no case updates). A per-workspace `config/integrations.json` (git-ignored) must be filled from read-only discovery before any publishing is allowed; the checked-in example intentionally fails validation. Output from the CLI is passed through a redactor that scrubs secret-looking keys, env values, bearer tokens and URL credentials.

- [.vscode/mcp.json](../../.vscode/mcp.json) — Playwright MCP, TestRail MCP (with `TESTRAIL_DISABLED_TOOLS` and delete=false), Atlassian Rovo HTTP endpoint.
- [orangehrm-regression.prompt.md](../../.github/prompts/orangehrm-regression.prompt.md) — `/orangehrm-regression author | run | publish` and the step-by-step publish protocol the agent must follow.
- [integrations.example.json](../../config/integrations.example.json) — shape of the destination config (`statusMap`, `discovery.toolSchemasValidated`, etc.).
- [publication-state.js:72](../../lib/publication-state.js#L72) — `redact`.
- [sync-results.js:70](../../scripts/sync-results.js#L70) — CLI entry: redacts both success output and errors.

## [x] Block 7 — Slice: what the unit tests prove

Mechanism: 17 `node:test` cases drive the state machine with fake receipts and a fake reporter run, one test per row of the plan's I/O & edge-case matrix. Read the test titles as a checklist of guaranteed behaviours.

- [integrations.test.js:64](../../tests/unit/integrations.test.js#L64) — first execution: case → run → result ordering enforced.
- [integrations.test.js:88](../../tests/unit/integrations.test.js#L88) — final failure gets a fresh Jira defect and the key lands on the TestRail result.
- [integrations.test.js:102](../../tests/unit/integrations.test.js#L102) — retry recovery never plans a defect.
- [integrations.test.js:134](../../tests/unit/integrations.test.js#L134) — timeout after submission must be reconciled before retry.
- [integrations.test.js:197](../../tests/unit/integrations.test.js#L197) — secret redaction.
- [integrations.test.js:239](../../tests/unit/integrations.test.js#L239) — reporter checkpoints retry evidence and keeps unfinished retries interrupted.
- Helpers at [integrations.test.js:9](../../tests/unit/integrations.test.js#L9)–[integrations.test.js:62](../../tests/unit/integrations.test.js#L62) show how a well-formed config, report and receipt look.

## [x] Block 8 — Periphery

- [package.json](../../package.json) — npm scripts: `test:unit`, `test:regression`, `test:list`, `sync:*`, `verify`.
- [README.md](../../README.md) — operator manual: local run, MCP setup, discovery, publication protocol.
- [.gitignore](../../.gitignore) — excludes `artifacts/`, `test-results/`, `config/integrations.json`, `config/receipts/`, `.env*`.
- [deferred-work.md](../deferred-work.md) — the single open item: live TestRail/Jira acceptance.
- [_bmad/](../../_bmad/) and [.agents/skills/](../../.agents/skills/) — installed BMad tooling used to author this project; not part of the harness.
- [artifacts/](../../artifacts/) — real past executions (five report folders) you can open to see a finished `report.json`.
