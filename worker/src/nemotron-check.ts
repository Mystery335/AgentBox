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

  // With reasoning on (the default): thinking tokens count against max_tokens.
  const t0 = Date.now();
  const chat = await db.nemotronChat({
    messages: [
      { role: 'system', content: 'You answer with JSON only.' },
      { role: 'user', content: 'Return {"language": "<name>"} for this code: IDENTIFICATION DIVISION. PROGRAM-ID. PAY.' },
    ],
    max_tokens: 4000,
    temperature: 0,
  });
  const c = chat.choices?.[0];
  const content = (c?.message?.content ?? '').trim();
  const reasoning = chat.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  console.log(`${content ? 'PASS' : 'FAIL'}  nemotron_chat  (${Date.now() - t0} ms, ${reasoning} reasoning tokens, finish=${c?.finish_reason}) -> ${content.slice(0, 200)}`);
  return content ? 0 : 1;
}

// Set exitCode instead of calling process.exit(): exiting while fetch's
// sockets are closing trips a libuv assertion on Windows.
main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(e => {
    console.error(`FAIL  ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  });
