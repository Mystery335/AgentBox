# AgentBox
 
**Old code. New possibilities.**
 
AgentBox modernizes legacy software with a team of AI agents, and proves the result still behaves the same. Give it a legacy system packaged as a Dockerfile (COBOL, Assembly or another language). Four NVIDIA Nemotron agents then analyze it, rewrite it in a modern language, run both versions on the same inputs and fix any differences. You watch every step live in one dashboard.
 
Built for HackUTD 2026.
 
## The problem
 
Banks, governments and other large organizations still depend on decades-old COBOL and Assembly. The code still runs, but nobody can safely change it:
 
- **It's hard to read.** Most engineers don't know these languages, and the original authors are often gone.
- **The rules live only in the code.** Business rules are buried in GOTOs, REDEFINES and packed decimals, and they aren't documented anywhere else.
- **Rewrites break silently.** New code compiles and looks right, but a rounding rule or edge case changes, and nobody notices until production.
Rewrites rarely fail on syntax. They fail on behaviour nobody wrote down.
 
## The solution
 
AgentBox turns a legacy system into modern code plus the evidence that both versions behave the same:
 
1. **Upload.** Drop in a zip that contains the legacy system and its Dockerfile. AgentBox builds it in a locked-down sandbox.
2. **Analyze.** The Analyzer maps the files, dependencies, data layouts and business rules. It also chooses the best-fit modern language (for example, Assembly becomes C) and explains why.
3. **Rewrite.** The Translator rewrites each component in that language and keeps its business logic.
4. **Verify and debug.** The Verifier runs both versions on the same inputs and compares the outputs. The Debugger fixes any mismatches and sends the code back for another check.
5. **Review.** Every business rule links back to the source lines it came from, and a person approves what ships.
## The agents
 
| Agent | Tools | Answers the question |
|---|---|---|
| **Analyzer** | File scanner, language detector, dependency scanner | What does the project do, and what needs modernizing? |
| **Translator** | Source reader, code generator, static analyzer | How should each component be translated? |
| **Verifier** | Docker executor, test runner, output comparator | Has the behaviour been preserved? |
| **Debugger** | Error analyzer, code editor, test runner | What needs fixing, and is another attempt needed? |
 
The agents act on their own: each one plans its steps, calls real tools and hands off to the next. They aren't a chatbot answering prompts.
 
## Features
 
- Safe upload of a legacy system: zip extraction blocks path tricks, symlinks and oversized archives, then builds the Dockerfile.
- Locked-down sandbox: no network, a read-only filesystem, capped CPU and memory, and no secrets passed in.
- Analyzer: inventory, dependencies, data layouts, business rules with their source lines, risky constructs, recommended target language, and a plain-English summary.
- Live dashboard: every agent step is pushed to the browser as it happens, with no polling.
- Run stages enforced by the database, so a run can't skip a stage.
- Watchdog: agents send heartbeats, and a scheduled job fails any run idle for 15 minutes.
- Rule approval: reviewers can approve business rules only after they've been verified.
- Reuses the legacy system's own tests when it has them, and generates tests when it doesn't (in progress).
- Translator, Verifier and Debugger agents (in progress).
- Piloting on a real COBOL system.
## Design & AI interaction
 
AgentBox's UI/UX was designed in **Figma**: the layouts, components and user flows were designed there before they were built in React. The interface uses a dark navy and violet theme with circuit-board details, glowing "before and after" code cards and a cube for the transformation. It keeps the original code and the modern code side by side on every screen.
 
Every agent runs on **NVIDIA Nemotron** through NVIDIA's OpenAI-compatible API. SpacetimeDB holds the NVIDIA API key in the database's environment. The worker calls Nemotron through SpacetimeDB procedures (`nemotron_chat`), so the key is never stored in a table, the worker or a container.
 
## Tech stack
 
| Layer | Tools |
|---|---|
| Design | Figma |
| Frontend | React, Vite, TypeScript, Tailwind CSS |
| Backend & hosting | SpacetimeDB (TypeScript module), which hosts the database on Maincloud |
| Secrets | NVIDIA API key stored in the SpacetimeDB database environment |
| AI | NVIDIA Nemotron (NIM API) for all four agents |
| Agent worker | TypeScript (Node.js), `openai` and `spacetimedb` npm packages |
| Sandbox | Docker |
 
Almost all backend logic is in the SpacetimeDB module: tables, reducers, the stage-order state machine, the `run_summary` view, the scheduled watchdog, worker presence and the Nemotron procedures. The worker runs outside the database only because it has to start Docker containers.
 
## Architecture
 
```
Legacy system (.zip + Dockerfile)
   |
   v
Agent worker (TypeScript, on the host)
   |-- builds and runs the legacy system in Docker (locked down)
   |-- runs the agent loops: Analyzer -> Translator -> Verifier <-> Debugger
   |
   |  calls reducers / procedures
   v
SpacetimeDB module on Maincloud (database: legacy-data)
   |-- tables: program, run, code_version, rule, test_case,
   |           test_result, change, debug_attempt, agent_event
   |-- stage order: analyzing -> analyzed -> translating -> verifying
   |                <-> debugging -> shadow -> ready_for_cutover
   |-- run_summary view, scheduled watchdog, worker presence
   '-- nemotron_chat procedure -> NVIDIA Nemotron API
   |
   |  pushes new rows over WebSocket
   v
Dashboard (React) -- subscribes once and re-renders live
```
 
## Getting started
 
### Prerequisites
 
- Node.js 24 or newer
- Docker
- The SpacetimeDB CLI (PowerShell: `iwr https://windows.spacetimedb.com -useb | iex`)
- An NVIDIA API key for Nemotron
### 1. Clone and install
 
```bash
git clone https://github.com/Mystery335/AgentBox.git
cd AgentBox
cd spacetimedb && npm install && cd ..
cd worker && npm install && cd ..
cd dashboard && npm install && cd ..
```
 
### 2. Create your environment file
 
Copy the template and fill in your values. Never commit `.env`.
 
```bash
cp .env.example .env
```
 
| Variable | What it is |
|---|---|
| `STDB_HOST` | SpacetimeDB HTTP address, for example `https://maincloud.spacetimedb.com` |
| `STDB_DB` | Database name, for example `legacy-data` |
| `STDB_TOKEN` | Worker token. Its identity must be registered as a writer (see below) |
| `VITE_STDB_URI` | WebSocket address for the dashboard, for example `wss://maincloud.spacetimedb.com` |
| `VITE_STDB_DB` | Database name for the dashboard |
 
Set `NVIDIA_API_KEY` in the **database's environment** on spacetimedb.com, not in `.env`.
 
### 3. Publish the backend
 
```bash
spacetime login
cd spacetimedb
spacetime publish legacy-data --server maincloud -c on-conflict -y
cd ..
spacetime call legacy-data --server maincloud add_writer '"<worker identity hex>"'
```
 
On Windows, `.\scripts\publish.ps1` type-checks and publishes in one step.
 
### 4. Run it
 
```bash
# Check the backend (runs the smoke test against the live database)
cd worker && npm run smoke
 
# Analyze a legacy system
npm run analyze -- path/to/legacy.zip
 
# Start the dashboard
cd ../dashboard && npm run dev
```
 
Open http://localhost:5173.
 
## Future improvements
 
Security ideas we want to look into next:
 
- **Jailbreak and prompt-injection resistance:** legacy code and comments are untrusted input, so a crafted comment shouldn't be able to steer an agent. We want to test the agents against jailbreak attempts hidden in source files and harden their prompts and tool permissions.
- **Stricter sandboxing:** limit what each agent's tools can do, and tighten the Docker builds (builds can still use the network today).
- **Secret and risk scanning:** flag credentials, hard-coded secrets and unsafe constructs in the legacy code before it's rewritten.
 
