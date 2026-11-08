# Block 1 diagram — how the three layers fit together

Shows only what the linked code does. Open with VS Code Markdown Preview (Ctrl+Shift+V) to render.

```mermaid
flowchart TB
  subgraph L1["Layer 1 · Run tests (local, offline-capable)"]
    direction LR
    CAT["tests/catalog.json<br/>5 scenario definitions<br/>OHRM-AUTH-001…005"]
    SPEC["tests/orangehrm.spec.js<br/>5 Playwright tests<br/>named '&lt;id&gt; &lt;title&gt;'"]
    CFG["playwright.config.js<br/>1 worker · 1 retry · Chromium"]
    CAT -- "bound by ID" --> SPEC
    CFG --> SPEC
  end

  DEMO[("OrangeHRM demo<br/>opensource-demo.orangehrmlive.com")]
  SPEC -- "drives browser" --> DEMO

  subgraph L2["Layer 2 · Record evidence"]
    REP["reporters/regression-reporter.js<br/>checkpoint at start / each attempt / end"]
    JSON["artifacts/&lt;uuid&gt;/report.json<br/>+ copied screenshots/traces<br/>artifacts/latest.json → newest run"]
    REP --> JSON
  end
  SPEC -- "results" --> REP

  subgraph L3["Layer 3 · Track publishing (local state only)"]
    CLI["scripts/sync-results.js<br/>--dry-run · --prepare · --begin<br/>--receipt · --check"]
    PS["lib/publication-state.js<br/>operation graph: case → run → defect → result<br/>pending → ready → submitting → confirmed"]
    STATE["artifacts/publication/&lt;destination&gt;.json<br/>confirmed remote IDs, receipts"]
    ICFG["config/integrations.json (git-ignored)<br/>TestRail/Jira destination + discovered schema"]
    CLI --> PS --> STATE
    ICFG --> PS
  end
  JSON -- "report path" --> CLI

  subgraph AG["Copilot agent · /orangehrm-regression publish"]
    PROMPT[".github/prompts/orangehrm-regression.prompt.md"]
  end
  CLI <-- "intents out · receipts in" --> PROMPT

  subgraph MCP["MCP servers (.vscode/mcp.json)"]
    TR["TestRail MCP<br/>add_case · mutate_run(create) · add_results_for_cases"]
    JIRA["Atlassian Rovo MCP<br/>create issue"]
  end
  PROMPT -- "MCP calls" --> TR
  PROMPT -- "MCP calls" --> JIRA

  classDef local fill:#e8f4ea,stroke:#2e7d32,color:#000
  classDef remote fill:#fdecea,stroke:#c62828,color:#000
  classDef agent fill:#fff8e1,stroke:#f9a825,color:#000
  class CAT,SPEC,CFG,REP,JSON,CLI,PS,STATE,ICFG local
  class DEMO,TR,JIRA remote
  class PROMPT agent
```

Legend: green = code/files in this repo that run on your machine · red = remote systems · yellow = the AI agent, which is the **only** thing that ever talks to TestRail or Jira. `sync-results.js` never performs a remote write; it only hands the agent a payload ("intent") and records what the agent reports back ("receipt").
