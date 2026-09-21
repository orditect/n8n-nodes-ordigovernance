# n8n-nodes-ordigovernance

n8n community nodes for the [ordigovernance gateway](https://github.com/orditect/orditect-governance)
— the HTTP execution front of the orditect-governance stack. Every
tool call, task execution and HITL action issued from n8n lands as an
audited, budgeted, idempotent governed call on the gateway's hot
path: semaphores, budgets, call_id idempotency, audit events,
execution generations and lineage pins, all inspectable in the
cold-path viewer.

Governance disclosure: this package is a **pure HTTP client**. It
never imports any governance or engine package (those live in the
orditect-governance repository under SUL-1.0); n8n talks to the
gateway over HTTP only. This package is MIT-licensed.

**Zero runtime dependencies, zero peer dependencies** — the package
contains only ordinary action nodes over the gateway's HTTP API.

## Requirements

- n8n (the version this release was smoke-verified against is
  recorded in [RELEASE-SMOKE.md](RELEASE-SMOKE.md))
- A running ordigovernance gateway (write path); for the Evidence
  node, a viewer host (read path)

## Installation

Install from the n8n UI (Settings > Community Nodes), or into your
custom extensions directory:

    # inside ~/.n8n/custom
    npm install n8n-nodes-ordigovernance

Restart n8n; the nodes appear under "Ordigovernance".

## Credentials

One credential type: **Ordigovernance Gateway API** (`ordigovernanceApi`)

- `Base URL` — gateway root, e.g. `http://localhost:8180`
- `Token` — bearer token matching the gateway's `GATEWAY_AUTH_TOKEN`
- `Viewer Base URL` — cold-path viewer host for the Evidence node
  (default `http://localhost:8181`)

The credential test calls `GET /runs` (an authenticated route), so a
wrong token fails the test rather than the first workflow run.

## Nodes

| node | kind | purpose |
|---|---|---|
| Ordigovernance Run | action | Start / finish / force-cancel a governed run |
| Ordigovernance Task | action | Submit a task (impl + params) and poll to terminal state |
| Ordigovernance Tool | action | One governed tool call (`POST /governed/tool-call`) |
| Ordigovernance Approval | action | HITL: pause / resume / retry + await a human decision |
| Ordigovernance Composite | action | Start a drive-level composite (e.g. a quality gate) and poll |
| Ordigovernance Evidence | action (read-only) | Cold-path evidence: generations, audit, validate, graph, tree |

## Using n8n's AI Agent with the gateway (built-in nodes)

The AI leg needs no community node: point n8n's built-in **OpenAI
Chat Model** at the gateway's OpenAI-compatible surface (gateway
design decision D18). Verified against n8n 2.35.7.

AI Agent (n8n built-in)
├─ Chat Model: OpenAI Chat Model (n8n built-in)
│    Credential → Base URL: http://localhost:8180/v1
│                 API Key:   <GATEWAY_AUTH_TOKEN>
│                 (credential test + model dropdown read GET /v1/models)
│    Model: <gateway client name>   (auto-listed from /v1/models)
│    ⚠️ Turn OFF "Use Responses API": current n8n OpenAI Chat Model
│       versions default to the Responses API (/v1/responses), which
│       the gateway does not serve — the chat-completions surface is
│       the supported one.
│    Credential → Add Custom Header:
│                 X-Governance-Run-Id: @active
│                 (routes every model call into the currently active
│                  run — audit rows land in the run's trace bundle and
│                  tokens count against the run's budget; when no run
│                  is active, calls degrade to the ambient run)
│
└─ Tool: Call n8n Workflow Tool (n8n built-in) → sub-workflow
     Sub-workflow: Execute Workflow Trigger → Ordigovernance Tool
     community node (tool name, inputs, run_id via expressions).
     - Define the tool's input schema on the Execute Workflow
       Trigger ("Workflow Input Schema"); pass each field to the tool
       with an AI expression, e.g.
       {{ $fromAI('query', 'the search query to run', 'string') }}
     - ⚠️ The sub-workflow must be PUBLISHED (n8n's ToolWorkflow
       refuses to call unpublished workflows).
     - The tool result JSON ({status, call_id, result, origin}) is
       what the agent sees; the search payload lives under result.

Alternative without publishing: the built-in Code Tool works with an
input schema and an in-code HTTP call to /governed/tool-call — useful
when you don't want a published sub-workflow.

Start the run with an explicit Run ID on the Ordigovernance Run node
so the `@active` header and the tool-side `run_id` resolve to the
same run. See `workflows/agent-governed.json` and
`workflows/agent-search-tool.json` for the verified canvases.

## Gateway contract quick reference

The authoritative tables live in
[docs/gateway-contract.md](docs/gateway-contract.md) (mirrored for CI
by the gateway's `test_node_wire_contract.py`, which extracts the
request schemas' field sets from the app's own openapi).

## Development

    npm install
    npm run build      # tsc + icons
    npm run lint
    npm test           # vitest: node contract suites over a mocked gateway

Note: the `n8n-workflow` dev dependency (types only) transitively
pulls `isolated-vm`, a native module requiring Node >= 22. On older
Node versions install with `npm install --ignore-scripts`; prefer
Node 22 when you also run n8n from this machine.

## Release (provenance)

Community nodes must be published via GitHub Actions with npm
provenance. Release flow:

    npm run release    # np: bump version, commit, tag, push (no publish)
    # the tag push triggers .github/workflows/publish.yml, which runs
    # npm publish --provenance on GitHub Actions

## Documentation

- [docs/gateway-contract.md](docs/gateway-contract.md) — wire contracts
- [docs/gateway-pitfalls.md](docs/gateway-pitfalls.md) — HTTP-visible
  lessons from live acceptance
- [RELEASE-SMOKE.md](RELEASE-SMOKE.md) — manual release gate