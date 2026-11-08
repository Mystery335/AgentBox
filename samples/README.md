# Sample legacy systems

Small legacy programs for demos and end-to-end tests of the pipeline.

| Sample | Language | What it does |
|---|---|---|
| `payroll-cobol/` | COBOL (GnuCOBOL, fixed format) | Weekly payroll from stdin: input validation, overtime at 1.5x over 40 hours, marginal tax brackets (10% / 20% / 30%), totals, return code 4 if any record is invalid. |

`payroll-cobol.zip` is the same folder zipped (no Dockerfile: the backend generates one with GnuCOBOL).

Run the whole pipeline (Analyzer -> Translator -> Verifier -> Debugger) from `worker/`:

```bash
npm run modernize -- ../samples/payroll-cobol.zip
```

Rebuild the zip after editing the sample (from `AgentBox/`):

```bash
python -c "import shutil; shutil.make_archive('samples/payroll-cobol', 'zip', 'samples', 'payroll-cobol')"
```
