# Release smoke runbook (manual, ~15 min)

Run this on a real n8n + real gateway + real endpoint before every
npm publish / gateway release. CI covers contracts; this covers the
real runtime behavior mocks cannot see (expression evaluation,
credential wiring, dispatcher liveness, built-in-node integration).

## Environment record

Record the versions this runbook was last verified against:

| component | version |
|---|---|
| n8n | 2.35.7 (Self Hosted) |
| gateway | (git rev / version) |
| node package | (version being released) |

## Setup

Two sibling checkouts are required:

    ~/Projects/orditect-governance        # gateway + demo registry
    ~/Projects/n8n-nodes-ordigovernance   # this repository

1. Terminal 1 (keep running):
   `cd ~/Projects/orditect-governance && scripts/dev-gateway.sh`
2. Terminal 2 (keep running):
   `cd ~/Projects/n8n-nodes-ordigovernance && scripts/dev-n8n.sh`
3. Browser: hard-refresh http://localhost:5678

## Checks (import from workflows/, or reuse saved canvases)

| # | Canvas | Pass criterion |
|---|---|---|
| 1 | m3-hitl-approval.json | pause -> cancelled visible in hot record; curl resume -> awaitDecision returns `approved` with new execution_id; receipt + prevs verified |
| 2 | m4-narrative.json | all five tasks `succeeded`; writer output `input_pins` has both researcher ids; audit shows no `search-*` line for writer |
| 3 | m5-quality-gate.json | composite `status: succeeded`; `outcome.iterations` >= 1; audit shows per-iteration `write-*` / `review-*` generations |
| 4 | fanout.json | all three researchers + writer `succeeded`; writer result `input_pins` carries the three researcher task ids; validate reports PASS |
| 5 | hitl-long.json | pause settles the task cancelled; external resume -> awaitDecision `approved` with a new execution_id; generation content read from the viewer |
| 6 | agent (built-in nodes) | AI Agent + built-in OpenAI Chat Model (Base URL `http://localhost:8180/v1`, "Use Responses API" OFF, custom header `X-Governance-Run-Id: @active`) + Call n8n Workflow Tool pointing at the PUBLISHED sub-workflow `workflows/agent-search-tool.json`. Pass: the conversation completes with at least one tool call; the RUN's audit stream shows `llm_call` rows (purpose `openai-compat-`) AND `search-` tool_call rows; after finishing the run, one more model call still succeeds (lands in the ambient run) — proving the `@active` sentinel survives run turnover |
During check 6, export the working canvas and commit it as
`workflows/agent-governed.json` (the editor export is the only
reliably importable form for AI-agent canvases; hand-authored agent
JSON is not).

## Audit spot-check (any run)

    RUN=<run_id>
    cat data/gateway-runs/$RUN/trace/audit.ndjson | python3 -c "
    import sys, json
    for line in sys.stdin:
        d = json.loads(line)['data']
        print(d['event_type'], '|', d.get('event_id',''))"

Every llm_call must carry usage tokens; every generation must have
its memsave-...-90 archive row.

## If any check fails

Do not publish. File the failure as a new pitfall (numbered, with the
locking test named) before fixing.