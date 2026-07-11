# Leaderboard worker

Cloudflare Worker + Workers KV backing the two game leaderboards. `GET/POST /leaderboard` — see `src/index.js`.

## First-time deploy
```
cd worker
npm install
npx wrangler login                        # opens browser OAuth to your Cloudflare account
npx wrangler kv namespace create LEADERBOARD_KV
# paste the returned id into wrangler.toml's kv_namespaces id field
npx wrangler deploy
```
Deploy prints the worker's `*.workers.dev` URL — put that in `LB_API` near the top of `index.html`'s script.

## Local dev
```
cd worker
npm install
npx wrangler dev
```
Runs on `http://localhost:8787` with a local (non-production) KV store.

## Redeploy after changes
```
cd worker
npx wrangler deploy
```
