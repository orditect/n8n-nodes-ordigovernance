# Gateway contract (node maintainer's reference)

The normative design record lives in the orditect-governance
repository (docs/gateway-design.md).This file carries the subset a
node maintainer needs: wire contracts and the decisions that shape
node behavior.

## Contract truth discipline

The gateway's **openapi.json is the only contract truth**. This
document mirrors it for humans; the gateway-side suite
`test_node_wire_contract.py` mirrors it for CI -- it extracts every
request schema's field set from the app's own openapi and pins the
node-visible behaviors (intent/metadata provenance, the cancel escape
hatch, the SSE frame vocabulary), so a schema edit that would
silently drop node fields fails the gateway build. When this file, a
node body, or the schema disagree, the openapi wins -- and the
disagreement is a bug to fix in the same commit.

## Call plane

| operation | method & path | body / notes |
|---|---|---|
| LLM chat | `POST /governed/llm-chat` | `{client, purpose, messages, kwargs, run_id?, task_id?}` -> `{status, call_id, response, usage?}` |
| LLM chat (stream) | `POST /governed/llm-chat-stream` | same request body; responds `text/event-stream` with the frames below; 422 with guidance when the registered client has no `stream()` |
| Tool call | `POST /governed/tool-call` | `{tool, inputs, run_id?, task_id?, reuse?}`; `inputs` expand as handler kwargs; reserved payload keys (`params`, `call_id`, `seq`, ...) -> 422 with a rename instruction |

`run_id` omitted routes to the **ambient run**; a given `task_id`
must belong to the addressed run (404 otherwise). Call ids follow the
naming discipline; seq slots are allocated per (task_id, purpose)
above the agent band.

### SSE frame vocabulary (`/governed/llm-chat-stream`)

One JSON object per `data:` line; the `done` frame terminates the
stream:

```
data: {"type": "delta", "text": "...", "reasoning": "..."}
data: {"type": "done", "call_id": "...", "usage": {...} | null}
data: {"type": "error", "detail": "..."}
```

- `reasoning` carries thinking-stage deltas (empty string when none);
- `usage` is present when the endpoint reports a usage tail chunk
  (`include_usage` is forced on by the endpoint);
- consumers must skip malformed/keepalive lines (comments, `[DONE]`)
  without failing the stream;
- stalls are governed by an IDLE timeout on the consumer side, not a
  total-duration timeout on the gateway.

## Task plane

| operation | method & path | body / notes |
|---|---|---|
| Start run | `POST /runs` | `{run_id?, budget_max_units?, intent?, metadata?}` -> 201 `{run_id, status}`; 409 single-active. `intent`/`metadata` are business provenance recorded verbatim on the registry entry |
| Finish run | `POST /runs/{id}/finish` | **no body**; `final_status` is derived from the tasks' terminal statuses -> `{run_id, final_status}`; 409 `{non_terminal_tasks}`; 404 when not active (D14) |
| Cancel run | `POST /runs/{id}/cancel` | **no body**; cooperative-cancels every RUNNING task, waits for terminal settlement, closes the run as cancelled -> `{run_id, status, cancelled_tasks}`; 404 when not active |
| Submit task | `POST /runs/{id}/tasks` | `{task_id, impl, params, upstream?, parent_task_id?, tools?}` -- the impl payload field is `params`; `tools` restricts the assembled tool set; unknown fields are silently ignored by the schema |
| Poll task | `GET /runs/{run_id}/tasks/{task_id}` | `{task_id, status, execution_id, previous_execution_ids, result?}`; active run only; 404 = finished/unknown (D14) |
| Vocabulary | `GET /runs/{id}/vocabulary` | also answers on `/runs/ambient/vocabulary` |

## HITL plane

| operation | method & path | body / notes |
|---|---|---|
| pause / resume / retry | `POST /runs/{id}/hitl/{action}` | pause/retry `{task_id}`; resume `{root_id?}` (defaults to the run root); returns the ACCEPTANCE receipt |
| receipt | `GET /runs/{id}/hitl/receipt/{action_id}` | 404 = pending; direct retry receipts answer immediately |

## Composites

| operation | method & path | body / notes |
|---|---|---|
| Start | `POST /runs/{id}/composites` | `{name, params}` -> 202 `{composite_id, accepted}` |
| Poll | `GET /runs/{id}/composites/{cid}` | `{composite_id, name, status, children: [{task_id, status, execution_id}], outcome}` |

The viewer host ships in the orditect-governance repo:

    GATEWAY_TRACE_ROOT=data/gateway-runs \
        python -m examples.gateway_n8n.viewer_app   # :8181, quiet

`GATEWAY_TRACE_ROOT` must match the gateway's setting (both default
to `data/gateway-runs` when launched from the same checkout).

## OpenAI-compatible surface (D18)

Served by the gateway for OpenAI-compatible clients that cannot call
the governed-native route (n8n's built-in OpenAI Chat Model node).
Same governed path as `/governed/llm-chat`; envelope swap only.

| operation | method & path | notes |
|---|---|---|
| Models | `GET /v1/models` | strict OpenAI models-list shape; the n8n OpenAI credential test and the model dropdown both read it |
| Chat completion | `POST /v1/chat/completions` | body `model` -> client registry key; `messages` verbatim; every other field transported opaquely as kwargs; `stream: true` yields OpenAI chunk envelopes (content / reasoning_content / tool_calls deltas) ending with a usage chunk + `data: [DONE]`; errors use the OpenAI error envelope |

Attribution headers: `X-Governance-Run-Id` (`@active` sentinel ->
active run resolved per request, degrades to ambient when none is
active; explicit id -> strict, 404 when not active),
`X-Governance-Task-Id` (D8 semantics), `X-Governance-Purpose`
(default `openai-compat`). Absent headers -> ambient run (D2).
Retry note: an OpenAI SDK retry is a fresh governed call and may
bill twice.

## Evidence plane (viewer cold path)

Reads are served by the **viewer host** (`viewerBaseUrl` on the
credential), never by the gateway (D14). All endpoints are
run-scoped under `/api/runs/{run_id}`:

| operation | path | notes |
|---|---|---|
| Generation content | `GET .../generations/{task_id}/{eid}/content` | archived result + `input_pins` (lineage-walk raw material) |
| Generations | `GET .../generations?root_id=` | every execution generation (time travel) |
| Audit | `GET .../audit?task_id=` | governed-call rows (usage, cost, evidence pointers) |
| Validate | `GET .../validate?root_id=` | run_rules self-certification |
| Graph / Tree | `GET .../graph?root_id=` / `.../tree?root_id=` | dependency edges / latest lineage |

Generation-content reads resolve the gateway's memo/archive body: for
a **redis-backed gateway** set `GATEWAY_REDIS_URL` on the viewer host
too; a memory-mode body lives inside the gateway process and is
invisible to the viewer (501 with guidance).

## Auth

`Authorization: Bearer <GATEWAY_AUTH_TOKEN>` on everything except
`/healthz`. The credential test therefore exercises `GET /runs` (an
authenticated route): a wrong token must fail the credential test,
not the first real call.

## Decisions that shape node behavior

- **Contract drift is silent** (pydantic drops unknown fields): node
  bodies carry exactly the schema vocabulary above; the openapi is
  the truth and both sides pin it in CI.
- **D5/D14**: finish takes no body and derives `final_status`; hot
  reads die with the run; historical evidence belongs to the viewer.
- **Cancel**: the escape hatch for a wedged run -- never restart the
  gateway mid-run (dead dispatcher).
- **D7**: the duplicate guard is run-scoped; ids must still be unique
  per execution (`{{ $execution.id }}`).
- **D8**: unknown task -> 404; omitted -> ephemeral identity.
- **D10**: composites are drive-level; failures land on the
  composite's own status.
- **D11**: one execution per item; colliding ids auto-suffixed.
- **Terminal is not success**: nodes surface any non-succeeded
  terminal status as an error.
- **Dual receipts**: acceptance != execution; poll the receipt.
