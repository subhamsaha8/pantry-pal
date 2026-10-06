# Pantry Pal — an MCP server for Alexa+

Pantry Pal is a self-hosted **Model Context Protocol server** that lets Alexa+ manage a household pantry by voice: what you bought, what's about to expire, what you can cook tonight, and what to buy next.

- **Transport:** MCP Streamable HTTP (single `POST /mcp` endpoint, JSON responses)
- **Spec:** `2025-11-25` (also negotiates `2025-06-18` and `2025-03-26`)
- **Dependencies:** none. Plain Node.js 18+ built-ins, so `git clone && npm start` just works.

> Built for the Amazon Developer Hackathon, **Alexa+ track**.

## Why this exists

Food waste is a household problem that voice is perfect for: your hands are full of groceries when you want to log them, and you ask "what should I cook?" while standing in the kitchen. Every tool returns a short sentence written to be **read aloud**, plus `structuredContent` for richer clients.

## Quick start

```bash
npm start                  # http://127.0.0.1:3000/mcp
npm test                   # 16 end-to-end tests against the live HTTP server
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind TLS |
| `PANTRY_TOKEN` | *(unset)* | If set, requests need `Authorization: Bearer <token>` |
| `ALLOWED_ORIGINS` | *(unset)* | Comma-separated extra browser origins (localhost is always allowed) |
| `PANTRY_DATA` | `./data/pantry.json` | Where pantry state is stored |

## Tools

| Tool | What you'd say | Behaviour |
|---|---|---|
| `add_item` | "I bought a dozen eggs, they expire in 10 days" | Adds or tops up an item, optional expiry; removes it from the shopping list |
| `list_pantry` | "What's in my pantry?" | Reads items back |
| `expiring_soon` | "What should I eat first?" | Items expiring within N days (default 3), soonest first |
| `use_item` | "I used two onions" | Decrements; on the last one, offers the shopping list |
| `suggest_meals` | "What can I cook?" | Ranks recipes you can make, boosting ones that use expiring food; names the one missing ingredient for near-matches |
| `shopping_list` | "Add milk to my list" | `show` / `add` / `remove` / `clear` |

Read-only tools carry `readOnlyHint` annotations. Invalid input comes back as a tool result with `isError: true` (so the model can correct itself and ask you), while protocol problems return proper JSON-RPC errors.

## Try it without Alexa

```bash
npm start &

curl -s localhost:3000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -s localhost:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"add_item","arguments":{"name":"eggs","quantity":6,"expires_in_days":2}}}'
```

You can also point the official **MCP Inspector** at `http://127.0.0.1:3000/mcp` (Streamable HTTP).

## Connecting to Alexa+

Alexa+ needs to reach your server over **public HTTPS**, so expose it first:

1. Run the server with a token: `PANTRY_TOKEN=$(openssl rand -hex 24) HOST=0.0.0.0 npm start`
2. Put it behind TLS: a tunnel (`cloudflared tunnel --url http://localhost:3000`, ngrok) for the demo, or a reverse proxy / AWS (ALB, App Runner, ECS) for something durable.
3. Register `https://<your-host>/mcp` and the bearer token as the MCP integration in the Alexa+ developer console for your account.

I haven't been able to verify step 3 against a live Alexa+ Preview account from my build environment, so the exact console labels may differ from the above; the endpoint itself is a standard MCP Streamable HTTP server and is verified by the test suite.

## Design notes

- **Speakable output.** Responses are short, avoid lists of more than a handful of items, and end with a follow-up question when a decision is needed ("Want me to add it to your shopping list?").
- **Spec compliance.** `initialize` negotiates the protocol version and issues an `Mcp-Session-Id`; notifications get `202`; `GET` returns `405` (no standalone SSE stream); `DELETE` ends a session; JSON-RPC batching is rejected as of 2025-06-18; `MCP-Protocol-Version` is validated; `Origin` is checked to block DNS-rebinding.
- **Safe by default.** Binds to localhost, optional bearer auth, 256 KB body cap, atomic file writes.
- **Single household.** State is one JSON file. Multi-user accounts and OAuth are the obvious next step.

## Layout

```
server.js   MCP server + tools (the whole thing, ~350 lines)
test.js     end-to-end tests (node:test)
```

## License

MIT, see `LICENSE`.
