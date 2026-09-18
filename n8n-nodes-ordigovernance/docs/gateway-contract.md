# Gateway contract (node maintainer's reference)

The normative design record lives in the orditect-governance
repository (docs/n8n-bridge-design.md). This file carries the subset
a node maintainer needs: wire contracts and the decisions that shape
node behavior. When the gateway version differs, adjust the path
constants at the top of each node file and update this file.

## Wire contracts (verified M2-M5, gateway v0.1)

| operation | method & path | body / notes |
|---|---|---|
| Start run | `POST /runs` | `{run_id?, budget_max_units?}` -> 201; 409 single-active |
| Finish run | `POST /runs/{id}/finish` | no body; 409 `{non_terminal_tasks}`; 404 when not active (D14) |
| LLM chat | `POST /governed/llm-chat` | `{client, purpose, messages, kwargs, run_id?, task_id?}` |
| Tool call | `POST /governed/tool-call` | `{tool, inputs, run_id?, task_id?}`; inputs expand as handler kwargs |
| Submit task | `POST /runs/{id}/tasks` | `{task_id, impl, params, upstream?, parent_task_id?, tools?}` -- the impl payload field is `params`; unknown fields are silently ignored by the schema |
| Poll task | `GET /runs/{run_id}/tasks/{task_id}` | active run only; 404 = finished/unknown (D14) |
| HITL pause/resume/retry | `POST /runs/{id}/hitl/{action}` | pause/retry `{task_id}`; resume `{root_id?}`; returns acceptance receipt |
| HITL receipt | `GET /runs/{id}/hitl/receipt/{action_id}` | 404 = pending; direct retry receipts answer immediately |
| Start composite | `POST /runs/{id}/composites` | `{name, params}` -> 202 `{composite_id}` |
| Poll composite | `GET /runs/{id}/composites/{cid}` | `{status, children[], outcome}` |
| Vocabulary | `GET /runs/{id}/vocabulary` | also answers on `/runs/ambient/vocabulary` |

Auth: `Authorization: Bearer <GATEWAY_AUTH_TOKEN>` on everything
except `/healthz`.

## Decisions that shape node behavior

- **D7 (run-scoped dedup)**: same-run duplicate task_id -> 409;
  ids must still be unique per execution (`{{ $execution.id }}`)
  because cross-run reuse muddies evidence attribution.
- **D8 (call identity)**: unknown task -> 404; omitted -> ephemeral;
  seq bands are allocated gateway-side.
- **D10 (composites)**: drive-level background drivers; children
  attach to the run root; failures land on the composite status.
- **D11 (multi-item)**: one execution per item; colliding ids are
  auto-suffixed with the item index.
- **D14 (read boundary)**: hot reads die with the run; historical
  evidence belongs to the viewer over the shared trace_root.
- **Terminal is not success**: nodes surface any non-succeeded
  terminal status as an error (canvas honesty).
- **Dual receipts**: acceptance != execution; poll the receipt
  endpoint (404 = pending).