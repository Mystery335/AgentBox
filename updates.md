# AgentBox — team revision plan

Prepared November 8, 2026, for the demo deadline.

**Goal:** demonstrate one real legacy program going through analysis, translation, execution-based verification, and repair when needed, with the dashboard showing the actual run.

**Review baseline:** local `main` at `2a589c8` (`Merge pull request #4 from Mystery335/vian/agentTesting`) and `shared-context-v3.md`. A teammate may already have fixed an item on another branch. Check that code first; mark confirmed fixes done instead of rebuilding them. The earlier goals document is planning context, not evidence that a feature works.

**Team ownership**

| Owner | Owns | Main files |
|---|---|---|
| Hailey — frontend/design | Real run selection, accurate screens, loading/error states, readable demo flow | `dashboard/src/Workspace.tsx`, `AgentActivity.tsx`, `ValidationInvestigation.tsx`, `Documentation.tsx`, `NewModernization.tsx` |
| Agent teammate | Nemotron calls, sample execution, translation, verification, debugger, model evidence | `worker/src/analyzer/`, `worker/src/modernize/`, `worker/src/llm.ts` |
| Backend teammate | SpacetimeDB data contract, subscriptions/bindings, credentials, execution entry point | `spacetimedb/src/index.ts`, `worker/src/stdb.ts`, `dashboard/src/stdb.tsx`, generated bindings |

Checklists are not marked complete until their acceptance checks pass.

## 1. Agree on the demo before changing code — all three, 5 minutes

- [ ] Use `samples/payroll-cobol.zip` as the first fixture. Confirm the archive is the version the team intends to demo.
- [ ] Pick one compiling payroll program. State the scope as **one program's tested behavior**, not an entire banking system.
- [ ] Choose one supported target language. Record the actual target chosen by the Analyzer; do not display an unrelated dropdown choice.
- [ ] Decide the execution entry point: **CLI starts the run; dashboard observes it** is the fastest valid route. A working upload-to-worker route is a separate enhancement.
- [ ] Assign one person to integrate changes. Each owner works on a separate branch and identifies the shared files they need to touch.
- [ ] Use the same run ID everywhere. Save it in the team chat along with input ZIP, source program, target, and worker machine.

**Done when:** everybody can describe the same 60–90-second demo and knows who starts the worker.

## 2. P0 — make one real pipeline run work

### A1 — Agent teammate: establish a runnable baseline

**Problem:** the reviewed Mac checkout has no worker `.env` and worker dependencies are not installed. This does not prove the teammate's configured machine is broken.

**How:**

1. Use the machine that already has Docker, a writer identity, and the worker dependencies.
2. Confirm Docker is running and the worker's SpacetimeDB credentials point at the intended database.
3. Run `npm run nemotron-check` from `worker/`.
4. Run `npm run modernize -- ../samples/payroll-cobol.zip`.
5. Capture the run ID, source program, target language, actual outputs, final status, and any error. Fix the first failing stage before adding features.
6. Pre-pull the target runtime image and build the sample image before presenting. A cold container build can consume the demo.

**Acceptance:** original and generated programs both execute in Docker; persisted test results contain actual input and output evidence. A terminal message alone is insufficient.

### A2 — Agent teammate: prove model usage honestly

**Problem:** all four roles route through the Nemotron client in source, but configuration alone does not prove which model answered a particular run. Responses may come from cache, and Debugger runs only if a repair is needed.

**How:**

- Record NVIDIA's response `model`, agent role, token usage, and cached/live status for Analyzer, Translator, Verifier test design, and each Debugger attempt.
- Preserve the Verifier's and Debugger's returned stats; the reviewed pipeline currently discards or incompletely records them.
- Keep the API key in the backend environment. Never put worker credentials or the NVIDIA key in `VITE_*` variables.
- For a fresh run in macOS/Linux/Git Bash: `NEMOTRON_CACHE=0 npm run modernize -- ../samples/payroll-cobol.zip`.
- Label any cached replay. If translation passes immediately, show Debugger as **Not needed**, not Running or Complete with invented work.

**Acceptance:** a judge can inspect the model identity and execution evidence for each agent that actually ran.

### A3 — Agent teammate: match claims to what verification measures

**Problem:** the current implementation verifies a selected program on generated stdin inputs. It normalizes output whitespace/line endings and compares exit codes; it does not establish universal equivalence or arbitrary file/database state equivalence.

**How:**

- Report **All tested cases match** instead of **Proof complete / production ready**.
- State the program, case count, holdout count, normalization policy, and remaining untested rules.
- Keep holdout inputs/outputs out of Translator examples and Debugger failure feedback.
- If a test hangs or gets dropped, expose that count; do not hide reduced coverage.
- Existing tests are discovered but the reviewed modernization path generates fresh cases. If existing tests are not integrated before the deadline, disclose that limitation.

**Acceptance:** success text accurately describes the measured evidence and does not imply a full-system guarantee.

## 3. P0 — make actual results available to the frontend

### B1 — Backend teammate: deliver a stable read contract

**Problem:** connection hooks exist, but the pages still use local sample arrays. Frontend needs more than a database connection: it needs all the data used by each screen.

**How:** extend `dashboard/src/stdb.tsx` or provide a small adapter layer that exposes:

| Screen data | Source / expected shape |
|---|---|
| Run selector and header | `run`, `run_summary`: ID, name, source, actual target, status, start time |
| Agent timeline | `agent_event`: run ID, timestamp, role, message |
| Business rules | `rule`: title, source line range, modern line range, status |
| Original code | Readable source content for the selected program; agree where this comes from |
| Generated code | `code_version`: run ID, attempt, code |
| Test evidence | Join `test_case` + `test_result` for the selected attempt |
| Repair history | `debug_attempt` + `change` |
| Documentation | `run.documentation` and/or structured `analysis` entries |
| Model provenance | Stored analysis/events with response model and cached/live usage |

- Subscribe only to the intended run where possible. Return loading and error states alongside data.
- Document camelCase client field names with one example object per adapter.
- Derive worker freshness from heartbeat timestamps; the plan already identifies that HTTP writer calls make `worker_presence.online` misleading.
- Fix the eight Fast Refresh lint errors in `stdb.tsx` by separating the provider component from exported hooks/helpers; update imports.
- Do not hand the browser a writer token to get around permissions.

**Acceptance:** Hailey can render each screen from returned objects, and a new event/result appears without a page refresh. Empty runs produce empty data, not the registration-service example.

### B2 — Backend teammate: resolve the Start button boundary

**Problem:** `NewModernization.tsx` currently prepares a local draft. It never sends source bytes to the worker or creates a running job.

**Choose the deadline-appropriate path:**

**Fastest: CLI-driven demo**

- Worker starts from the terminal; dashboard selects and watches the run.
- Rename the frontend action to **Prepare draft** or clearly label it as a local draft workflow.
- Keep source-upload/agent execution out of the live pitch if that bridge is unfinished.

**If the execution endpoint already exists:**

- Give Hailey its exact request, response, and error contract.
- Send the actual ZIP bytes, not just filename metadata.
- Return a run ID and a queued/running/failed state.
- Reject unsupported input clearly. Ensure the selected project name and target either reach execution or are explicitly ignored because the Analyzer chooses the target.
- Keep privileged execution on the worker side; never in browser code.

**Acceptance:** either the button starts a real tracked run, or it truthfully says it prepares a draft. No success dialog may imply agents ran when they did not.

## 4. P0 — Hailey: turn the design into an evidence viewer

### F1 — Replace mock data, one screen at a time

**Order:** workspace header → activity → validation → code/rules → documentation.

- [ ] Add a run selector using `useRuns` / summaries. Preserve the chosen run ID across all screens and page refreshes.
- [ ] Replace fixed project name, Run 0042, percentages, agent statuses, source language, and target language.
- [ ] Feed `AgentActivity` real events. Explain what is happening now in plain language.
- [ ] Feed Validation actual cases/results for the latest or explicitly selected attempt. Filters must count the data being displayed.
- [ ] Connect selected rule → original source lines → generated source lines. Keep source read-only.
- [ ] Render the run's generated documentation, not `documentationData.ts`.
- [ ] Export the selected run's actual evidence, not the fixed example report.

**Where to start:** `Workspace.tsx` owns much of the hardcoded state and passes data to the screens. Agree on backend adapters before rewriting each screen separately.

**Acceptance:** choose two different run IDs and the name, events, code, and results all change consistently. No real run shows the example's fixed 23/24 result.

### F2 — Make every state understandable

- [ ] Distinguish **Connecting**, **Loading run**, **No runs**, **Running**, **Failed**, and **Finished**.
- [ ] Show a real connection error and a retry action instead of leaving an empty or permanently spinning screen.
- [ ] Show one useful next step for failures: error text, failed stage, and where to inspect evidence.
- [ ] Use one naming scheme: **Analyze → Translate → Verify → Debug if needed**. Map backend role IDs to these labels.
- [ ] Show model identity and cached/live status as compact supporting information.
- [ ] Remove unsupported security counters and “isolated” claims from live states unless backed by execution evidence. Clearly label any retained sample mode.
- [ ] On the new-modernization screen, describe the real submission behavior agreed in B2.

**Acceptance:** a first-time viewer can identify the selected program, current stage, and outcome within five seconds.

### F3 — Focus the presentation

Keep the visual identity. Spend remaining design time on readable code, differences, output evidence, and useful states—not another redesign.

Suggested story:

1. “Here is the original payroll rule.”
2. “Nemotron generated this implementation.”
3. “We ran both against these inputs in Docker.”
4. “Here is an actual mismatch and repair, if one occurred.”
5. “These are the tested results and remaining limits.”

A successful first translation is a valid demo. If a repair example is needed, use a separate, explicitly labeled seeded-fault scenario. Do not manufacture a supposedly spontaneous failure.

## 5. P1 — only after the real demo works

- [ ] Agent teammate: reuse detected existing test suites where feasible; record test origin.
- [ ] Agent teammate: fail clearly on unsupported target languages instead of quietly falling back to Python.
- [ ] Backend + agents: preserve failure state when an exception occurs outside the normal pipeline error handlers; avoid stranded runs.
- [ ] Frontend: add attempt selection so earlier failing evidence can be compared with later results.
- [ ] Frontend: improve narrow-screen layout. The current desktop canvas can require horizontal scrolling; test on the actual presentation display first.
- [ ] Backend: confirm deployed module/bindings match the code being demonstrated.

## 6. Integration and acceptance rehearsal — all three

Do this before merging the final demo build:

- [ ] Start the sample with the agreed execution entry point.
- [ ] Open the exact run ID in the dashboard.
- [ ] Watch at least one real event arrive without refreshing.
- [ ] Inspect the actual original and generated code.
- [ ] Select a case and compare its input, baseline output, generated output, and result.
- [ ] Verify the displayed model and cached/live state against the worker evidence.
- [ ] If repairs happened, inspect the real attempt history. Otherwise, show Debugger as not needed.
- [ ] Refresh the page and confirm the same run is still selected.
- [ ] Export the evidence and confirm the downloaded run ID and results match the screen.
- [ ] Show a missing-file or failed-run state once. It must explain the issue rather than imply success.
- [ ] Run dashboard build/lint and worker typecheck/tests on the integrated checkout.

Commands:

```sh
# Agent/backend owner: from worker/, with dependencies and credentials configured
npm run nemotron-check
npm run typecheck
npm test
npm run modernize -- ../samples/payroll-cobol.zip

# Frontend owner: from dashboard/
npm run build
npm run lint
npm run dev
```

Do not use the backend smoke script against shared demo data without checking its writes first.

## 7. Fallback if time runs out

Use the real CLI pipeline plus a dashboard reading a previously completed real run. Label historical or cached data as such. Have a short recording of an actual run, the exact source ZIP, generated code, and exported test evidence available.

Avoid claiming upload-to-execution, arbitrary-system modernization, or production readiness if those paths are not demonstrated.

**Minimum finish line:** one authentic program, actual Nemotron calls, Docker execution, stored comparison evidence, and a dashboard displaying that same run.

## Review results already observed

- Dashboard production build: passed.
- Dashboard lint: eight Fast Refresh errors in `dashboard/src/stdb.tsx`, plus two generated-file warnings.
- Worker typecheck/tests on this Mac: not executed successfully; `tsc` was missing from worker dependencies.
- No local worker `.env` or response cache was present at review time. Deployed credentials and model responses were not verified.
- Upload form and visible report screens remained local examples in the reviewed source.

No source changes, deployment, commits, or pushes were performed as part of this document.


