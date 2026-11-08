# Backend setup (Person 3)

Database: `legacy-data` on Maincloud. Plan: `.claude/shared-context-v3.md` (GitHub folder).

## First-time setup
1. Install the CLI (PowerShell): `iwr https://windows.spacetimedb.com -useb | iex`
2. `spacetime login` with the account that owns `legacy-data`.
3. `copy .env.example .env`
4. Publish the module: `.\scripts\publish.ps1`
   - Never run the "Set up project" command from the database's web page; it publishes a chat template.
5. Worker deps: `cd worker && npm install`
6. Worker identity: `npm run identity`
   - Put the printed `STDB_TOKEN=...` line in `.env`. Don't share the token.
   - Register it as a writer (once, from the CLI login that published), using the command it prints:
     `spacetime call legacy-data --server maincloud add_writer '"<identity hex>"'`
7. Check the backend: `npm run smoke` (calls all 14 reducers, reads every table back).

## Legacy system (zip)
- `npm run dockerize -- path\to\legacy.zip`: safely extracts the zip to `.cache/legacy/<sha12>/`, finds its Dockerfile, and builds `agentproof-legacy:<sha12>`. Needs Docker Desktop running.
- `npm run run-legacy -- agentproof-legacy:<sha12> --stdin input.txt`: runs it offline with the locked-down flags.

## Files
| Path | What it does |
|---|---|
| `spacetimedb/src/index.ts` | The module: 9 tables + private `writer`, 14 reducers, writer check |
| `worker/src/unzip.ts` | Safe zip extraction (zip-slip, symlink and size checks) |
| `worker/src/dockerize.ts` | zip → Docker image |
| `worker/src/docker.ts` | Locked-down `docker run`, no env vars |
| `worker/src/stdb.ts` | SpacetimeDB HTTP client, one method per reducer |
| `worker/src/smoke.ts` | Backend smoke test |
| `scripts/publish.ps1` | Type-checks and publishes the module |
