import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';

const origin = 'http://127.0.0.1:4173';
mkdirSync('.local', { recursive: true });
const database = new DatabaseSync('.local/checkers.sqlite');
const initialized = database.prepare("SELECT name FROM sqlite_master WHERE name = 'game_state'").get();
if (!initialized) database.exec(readFileSync('drizzle/0000_state.sql', 'utf8'));

const DB = {
  prepare(sql) {
    const statement = database.prepare(sql);
    return {
      first: () => statement.get(),
      bind: (...args) => ({ run: () => ({ meta: statement.run(...args) }) }),
    };
  },
};

createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, origin);
    if (url.origin !== origin || incoming.headers.host !== url.host) {
      outgoing.writeHead(403).end();
      return;
    }
    if (url.pathname === '/signin-with-chatgpt') {
      const redirect = new URL(url.searchParams.get('returnTo') || '/', origin);
      outgoing.writeHead(303, {
        Location: redirect.origin === origin ? redirect.href : origin,
        'Set-Cookie': 'local_player=' + randomUUID() + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000',
      }).end();
      return;
    }
    const headers = new Headers(incoming.headers);
    headers.delete('oai-authenticated-user-id');
    const player = incoming.headers.cookie?.match(/(?:^|; )local_player=([a-f0-9-]{36})(?:;|$)/)?.[1];
    if (player) headers.set('oai-authenticated-user-id', player);
    const body = ['GET', 'HEAD'].includes(incoming.method) ? undefined : incoming;
    const response = await worker.fetch(new Request(url, {
      method: incoming.method, headers, body, duplex: 'half',
    }), { DB });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch {
    outgoing.writeHead(500).end('Local preview request failed.');
  }
}).listen(4173, '127.0.0.1', () => console.log('Crownline local preview at ' + origin));
