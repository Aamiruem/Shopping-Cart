# Arvixa Store MCP server

Lets an AI assistant (Claude Desktop, Claude Code or any [MCP](https://modelcontextprotocol.io) client) work with the
store: search the catalog, follow orders and payments, and, signed in as the store admin, handle returns, complaints,
prices and stock. It calls the store's own API, so every permission and check of the website applies.

## Tools

| Tool | Needs | What it does |
|---|---|---|
| `search_products` | nothing | Search by words, category, price; sort |
| `get_product` | nothing | Details, stock and verified-buyer ratings |
| `trending_products` | nothing | What's in demand right now |
| `related_products` | nothing | Bought together, viewed together, similar |
| `my_orders`, `order_details`, `payment_history` | an account | Orders, timelines, tracking, payments and refunds |
| `list_returns`, `process_return` | admin | Approve, reject, mark picked up (refund goes out), record a bank/UPI refund |
| `list_complaints`, `read_complaint`, `reply_to_complaint` | admin | Read tickets, reply, resolve |
| `low_stock`, `update_product` | admin | Find low stock; change price, stock, details, hide/list |

## Setup

```bash
cd mcp-server
npm install
```

Settings are environment variables:

- `STORE_URL`: the store (default `https://arvixa-store.vercel.app`; `http://127.0.0.1:5000` for `npm run local`)
- `STORE_EMAIL` and `STORE_PASSWORD`, or `STORE_TOKEN`: the account to act as. Leave them out for catalog tools only.

Use a dedicated account, and give the assistant the admin account only if you want it to change things.

### Claude Code

```bash
claude mcp add arvixa-store --env STORE_EMAIL=you@example.com --env STORE_PASSWORD=... -- node "D:/Aamir Project/Shopping-Cart/mcp-server/server.mjs"
```

### Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "arvixa-store": {
      "command": "node",
      "args": ["D:/Aamir Project/Shopping-Cart/mcp-server/server.mjs"],
      "env": { "STORE_EMAIL": "you@example.com", "STORE_PASSWORD": "..." }
    }
  }
}
```

The config file holds the password in plain text: keep it on your own computer, never in git.

## Test

`npm test` starts the local store (in-memory demo data) and drives every kind of tool over stdio.
