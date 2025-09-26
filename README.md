# tldr
`PORT=8545 UPSTREAM_URL=https://scroll.rpc.hypersync.xyz LOG_CHUNK_SIZE=100000 pnpm dev`

# Logs RPC Chunking Proxy

A minimal JSON-RPC proxy that splits large `eth_getLogs` requests into smaller block ranges before forwarding them to an upstream Ethereum RPC provider. The service is implemented in TypeScript with ethers v5 and can be used as a drop-in RPC URL when your client cannot change the queried block range.

## Features
- Transparently proxies JSON-RPC requests to an upstream endpoint.
- Automatically chunks `eth_getLogs` ranges into configurable block windows.
- Concatenates log results so the caller receives a single response.
- Forwards all other JSON-RPC methods without modification.

## Configuration
Set the following environment variables when running the server:

- `UPSTREAM_URL` (required): JSON-RPC endpoint to forward requests to.
- `PORT` (optional): Port to expose the proxy on. Defaults to `8545`.
- `LOG_CHUNK_SIZE` (optional): Chunk size in blocks for `eth_getLogs` ranges. Defaults to `100000`.

## Development
Install dependencies and run the service in development mode:

```bash
pnpm install
pnpm dev
```

The proxy listens on `http://localhost:8545` by default. Point your client at this URL instead of the original RPC endpoint.

## Production build
To produce JavaScript output and run it with Node.js:

```bash
pnpm build
pnpm start
```

## Testing the proxy
You can manually test the chunking behaviour using curl. The example below mirrors the failing query that motivated this proxy:

```bash
curl -X POST http://localhost:8545 \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 48,
    "method": "eth_getLogs",
    "params": [{
      "fromBlock": "0x0",
      "toBlock": "0x147299f",
      "address": "0x06efdbff2a14a7c8e15944d1f4a48f9f95f663a4",
      "topics": [["0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b"]]
    }]
  }'
```

The proxy will split the request into smaller block ranges, aggregate the log entries, and return a single JSON-RPC response.
