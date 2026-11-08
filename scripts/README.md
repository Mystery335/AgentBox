# Backend setup

Database: `legacy-data` on Maincloud. Module: `spacetimedb/` (TypeScript). Worker: `worker/` (TypeScript).

## First-time setup (everyone)
1. `copy .env.example .env`
2. Worker deps: `cd worker && npm install`
3. Worker identity: `npm run identity`
   - Put the printed `STDB_TOKEN=...` line in `.env`. Don't share the token; it's a password.
   - Send the printed **identity hex** (safe to share) to the database owner, who registers it as a writer:
     `spacetime call legacy-data --server maincloud add_writer '"<identity hex>"'`
   - Running `npm run identity` again creates a new identity that has to be registered again.
4. Check the backend: `npm run smoke` (calls all 16 reducers, reads every table back; leaves `smoke-*` rows).
5. Check Nemotron: `npm run nemotron-check` (ping + one chat call through the module).

## Owner only: publishing
Only the account that owns `legacy-data` can publish and add writers.
1. Install the CLI (PowerShell): `iwr https://windows.spacetimedb.com -useb | iex`
2. `spacetime login` with the owner account.
3. Publish: `.\scripts\publish.ps1` (keeps data). `.\scripts\publish.ps1 -Wipe` deletes **all** data; after a wipe the publisher is the only writer again.
   - Never run the "Set up project" command from the database's web page; it publishes a chat template.

## Nemotron API key
- Set `NVIDIA_API_KEY` on spacetimedb.com: `legacy-data` → Environment. Optionally set `NEMOTRON_MODEL` (default `nvidia/nemotron-3.5-lightning-30b-a3b`).
- Never put the key in `.env`, the repo, a public table, or a Docker container. Only the module reads it (`ctx.env`).
- Agents call `db.nemotronChat({ messages, ... })` in `worker/src/stdb.ts`, which runs the writer-only `nemotron_chat` procedure.
- Nemotron 3.5 is a reasoning model: thinking tokens count against `max_tokens`. Use 2000+ for real work, or pass `chat_template_kwargs: { enable_thinking: false }` for quick calls. A `/no_think` system prompt does not work.
- Procedures time out after 170 s (Maincloud's limit is 180 s).

## Analyzer agent
`npm run analyze -- path\to\legacy.zip [--only NAME,NAME] [--concurrency 4]`
1. Dockerizes the zip. If it has no Dockerfile, one is generated from the detected languages (`worker/src/analyzer/languages.ts`).
2. Scans every file (inventory, includes, calls, job control, DDL, existing tests).
3. Syntax-checks every program inside the locked-down container. Programs that compile and need nothing outside the sandbox (DB2, CICS, missing copybooks, ...) are **verifiable**; the rest are **deferred** with reasons.
4. Nemotron analyzes each program with tools (reads copybooks, called programs, JCL), then decides the target language, the first slice (verifiable only) and the migration order.
5. Everything streams to SpacetimeDB: `agent_event` (live log), `rule`, `analysis` (`system` / `inventory` / `component` / `runtime` rows), `run.documentation`, `run.target_language`.

Nemotron answers are cached in `.cache/nemotron/`, so a re-run of the same zip is fast and identical; `NEMOTRON_CACHE=0` bypasses it. To add a language, add a profile in `languages.ts` (extensions, scanner, toolchain, syntax-check command).

## Legacy system (zip)
- `npm run dockerize -- path\to\legacy.zip`: safely extracts the zip to `.cache/legacy/<sha12>/`, uses its Dockerfile or generates one, and builds `agentproof-legacy:<sha12>`. Needs Docker Desktop running.
- `npm run run-legacy -- agentproof-legacy:<sha12> --stdin input.txt`: runs it offline with the locked-down flags.

## Files
| Path | What it does |
|---|---|
| `spacetimedb/src/index.ts` | The module: 10 tables (incl. `analysis`) + private `writer`, 16 reducers, writer check, `nemotron_ping` / `nemotron_chat` procedures |
| `worker/src/analyzer/` | Analyzer: `languages.ts` (profiles), `scan.ts` (inventory, deps, verifiable/deferred), `runtime.ts` (Dockerfile generation, compile probe), `agent.ts` (Nemotron tool loop), `index.ts` (pipeline) |
| `worker/src/llm.ts` | Nemotron chat with retries, cache and tool-calling loop |
| `worker/src/unzip.ts` | Safe zip extraction (zip-slip, symlink and size checks) |
| `worker/src/dockerize.ts` | zip → Docker image |
| `worker/src/docker.ts` | Locked-down `docker run`, no env vars |
| `worker/src/stdb.ts` | SpacetimeDB HTTP client: one method per reducer, plus `nemotronPing` / `nemotronChat` |
| `worker/src/smoke.ts` | Backend smoke test |
| `worker/src/nemotron-check.ts` | Nemotron end-to-end check |
| `scripts/publish.ps1` | Type-checks and publishes the module |
| `.env.example` | Settings template (no secrets) |
