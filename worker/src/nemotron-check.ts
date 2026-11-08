// Checks the Nemotron setup end to end:
//   worker --HTTP--> SpacetimeDB procedure --ctx.env.NVIDIA_API_KEY--> NVIDIA API
//
//   npm run nemotron-check
//
// Needs: the module published with the nemotron_* procedures, NVIDIA_API_KEY
// set in the database's Environment settings, and a writer STDB_TOKEN in .env.
// Prints only status and the model's reply; the key never reaches this process.

import { Stdb } from './stdb.ts';

async function main(): Promise<number> {
  const db = new Stdb();
  if (!process.env.STDB_TOKEN) {
    console.error('STDB_TOKEN is empty in AgentBox/.env (see scripts/README.md).');
    return 2;
  }
  console.log(`target: ${db.host} / ${db.db}\n`);

  const ping = JSON.parse(await db.nemotronPing()) as { ok: boolean; status: number; model: string; reply: string; error: string };
  console.log(`${ping.ok ? 'PASS' : 'FAIL'}  nemotron_ping  (HTTP ${ping.status}, model ${ping.model}, reply "${ping.reply}")`);
  if (!ping.ok) {
    console.log(`      ${ping.error}`);
    return 1;
  }

  const t0 = Date.now();
  const chat = await db.nemotronChat({
    messages: [
      { role: 'system', content: 'You answer with JSON only.' },
      { role: 'user', content: 'Return {"language": "<name>"} for this code: IDENTIFICATION DIVISION. PROGRAM-ID. PAY.' },
    ],
    max_tokens: 200,
    temperature: 0,
  });
  const content = chat.choices?.[0]?.message?.content ?? '';
  console.log(`PASS  nemotron_chat  (${Date.now() - t0} ms) -> ${content.trim().slice(0, 200)}`);
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(`FAIL  ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
