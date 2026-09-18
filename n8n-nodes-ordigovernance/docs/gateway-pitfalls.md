# Gateway pitfalls visible from the HTTP side

Condensed from docs/pitfalls.md in the orditect-governance
repository (the normative log, with locking tests). These are the
lessons a node/canvas user can hit through the HTTP surface.

## 16.6 Duplicate task ids across runs

The duplicate guard is run-scoped, but a task id reused across runs
shares one hot-path record: a new run gets a FRESH GENERATION on the
previous run's record. Your evidence then mixes two runs' business
meaning under one id. Discipline: mint unique ids per execution
(`researcher-m3-{{ $execution.id }}`).

## 16.7 Ownership-checked reads

`GET /runs/{id}/tasks/{tid}` 404s for tasks that exist but belong to
another run, and for everything once the run finishes (D14). A 404
means "not yours or not active", not "does not exist".

## 16.8 Receipts for direct actions

HITL retry is synchronous (reopen + resubmit), so its
`retry-direct-*` receipt answers immediately at the receipt
endpoint. Sink-driven pause/resume receipts arrive asynchronously;
404 means pending. Either way: acceptance is not execution.

## 16.9 accepted != executed (dead dispatcher)

Field-verified: actions issued against a run whose dispatcher is
dead (gateway restarted mid-run, session evaporated) return
accepted=true and never execute; receipts never arrive. The only
truth is the execution receipt plus the hot record's
previous_execution_ids. Rule: never restart the gateway mid-run;
verify every action with receipt + record.