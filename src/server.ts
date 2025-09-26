import http from 'http';
import { BigNumber, providers, utils } from 'ethers';

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: string;
  method: string;
  id?: JsonRpcId;
  params?: unknown[];
};

type JsonRpcSuccess = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcErrorShape = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcErrorResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorShape;
};

type JsonRpcResponse = JsonRpcSuccess | JsonRpcErrorResponse;

type ResolvedBlock = { kind: 'number'; value: BigNumber } | { kind: 'tag'; tag: string };

class JsonRpcError extends Error {
  public readonly code: number;
  public readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const upstreamUrl = 'https://scroll.rpc.hypersync.xyz';

if (!upstreamUrl) {
  console.error('Missing upstream RPC URL. Set UPSTREAM_URL to a valid endpoint.');
  process.exit(1);
}

const defaultChunkSize = 100000;
const parsedChunkSize = parseChunkSize(process.env.LOG_CHUNK_SIZE, defaultChunkSize);
const chunkSizeBn = BigNumber.from(parsedChunkSize);

const provider = new providers.StaticJsonRpcProvider(upstreamUrl);

const port = parseInt(process.env.PORT || '8545', 10);

async function resolveBlockTag(tag: unknown): Promise<ResolvedBlock> {
  if (tag === undefined || tag === null) {
    return { kind: 'number', value: BigNumber.from(0) };
  }

  if (typeof tag === 'number') {
    return { kind: 'number', value: BigNumber.from(tag) };
  }

  if (BigNumber.isBigNumber(tag)) {
    return { kind: 'number', value: BigNumber.from(tag) };
  }

  if (typeof tag === 'string') {
    const normalized = tag.toLowerCase();

    if (normalized === 'earliest') {
      return { kind: 'number', value: BigNumber.from(0) };
    }

    if (
      normalized === 'latest' ||
      normalized === 'pending' ||
      normalized === 'safe' ||
      normalized === 'finalized'
    ) {
      const blockNumber = await provider.getBlockNumber();
      return { kind: 'number', value: BigNumber.from(blockNumber) };
    }

    if (/^0x[0-9a-fA-F]+$/.test(tag)) {
      return { kind: 'number', value: BigNumber.from(tag) };
    }
  }

  return { kind: 'tag', tag: String(tag) };
}

async function handleEthGetLogs(params: unknown[] = []): Promise<unknown> {
  const [rawFilter] = params;
  const filter = (rawFilter ?? {}) as Record<string, unknown>;

  if (filter.blockHash) {
    // When blockHash is provided, the range must not be present and chunking is unnecessary.
    return provider.send('eth_getLogs', [filter]);
  }

  const resolvedFrom = await resolveBlockTag(filter.fromBlock);
  const resolvedTo = await resolveBlockTag(filter.toBlock);

  if (resolvedFrom.kind !== 'number' || resolvedTo.kind !== 'number') {
    // Unable to derive numeric range, forward the request as-is.
    return provider.send('eth_getLogs', [filter]);
  }

  const fromBlock = resolvedFrom.value;
  const toBlock = resolvedTo.value;

  if (toBlock.lt(fromBlock)) {
    throw new JsonRpcError(-32602, 'Invalid params: toBlock must be >= fromBlock');
  }

  const results: unknown[] = [];
  let currentFrom = fromBlock;
  const one = BigNumber.from(1);
  const startedAt = Date.now();
  let chunkIndex = 0;
  let totalFetched = 0;

  while (currentFrom.lte(toBlock)) {
    const upperCandidate = currentFrom.add(chunkSizeBn).sub(one);
    const currentTo = upperCandidate.gt(toBlock) ? toBlock : upperCandidate;
    const chunkFilter = {
      ...filter,
      fromBlock: utils.hexValue(currentFrom),
      toBlock: utils.hexValue(currentTo),
    };

    const chunkStartedAt = Date.now();
    console.log(
      `[eth_getLogs] chunk ${chunkIndex} -> from ${chunkFilter.fromBlock} to ${chunkFilter.toBlock}`
    );
    const chunkResult = await provider.send('eth_getLogs', [chunkFilter]);

    if (!Array.isArray(chunkResult)) {
      throw new JsonRpcError(
        -32603,
        'Internal error: unexpected upstream response for eth_getLogs chunk',
        chunkResult
      );
    }

    results.push(...chunkResult);
    totalFetched += chunkResult.length;
    console.log(
      `[eth_getLogs] chunk ${chunkIndex} complete (${chunkResult.length} logs, ${((Date.now() - chunkStartedAt) / 1000).toFixed(2)}s)`
    );
    currentFrom = currentTo.add(one);
    chunkIndex += 1;
  }

  console.log(
    `[eth_getLogs] finished ${chunkIndex} chunks (${totalFetched} logs total, ${((Date.now() - startedAt) / 1000).toFixed(2)}s)`
  );
  return results;
}

async function dispatch(method: string, params: unknown[] = []): Promise<unknown> {
  if (method === 'eth_getLogs') {
    return handleEthGetLogs(params);
  }

  return provider.send(method, params);
}

function normalizeError(err: unknown): JsonRpcErrorShape {
  if (!err) {
    return { code: -32603, message: 'Internal error' };
  }

  if (err instanceof JsonRpcError) {
    const base: JsonRpcErrorShape = { code: err.code, message: err.message };
    if (err.data !== undefined) {
      base.data = err.data;
    }
    return base;
  }

  const anyErr = err as { code?: unknown; message?: unknown; data?: unknown };

  const code = typeof anyErr.code === 'number' ? anyErr.code : -32603;
  const message = typeof anyErr.message === 'string' ? anyErr.message : 'Internal error';
  const error: JsonRpcErrorShape = { code, message };

  if (anyErr.data !== undefined) {
    error.data = anyErr.data;
  }

  if (code === -32603 && error.data === undefined) {
    error.data = anyErr;
  }

  return error;
}

function parseChunkSize(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid LOG_CHUNK_SIZE value: ${rawValue}`);
  }

  return Math.floor(parsed);
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
    'Access-Control-Allow-Origin': '*',
  });

  res.write(body);
  res.end();
}

async function handleRequest(payload: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[]> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      throw new JsonRpcError(-32600, 'Invalid request: empty batch');
    }

    const responses = await Promise.all(payload.map((call) => processCall(call)));
    return responses;
  }

  return processCall(payload);
}

async function processCall(call: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id: JsonRpcId = call.id ?? null;

  if (call.jsonrpc !== '2.0' || typeof call.method !== 'string') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid request' },
    };
  }

  try {
    const result = await dispatch(call.method, call.params ?? []);
    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    const error = normalizeError(err);
    return { jsonrpc: '2.0', id, error };
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const chunks: Buffer[] = [];

  req.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');

    let payload: JsonRpcRequest | JsonRpcRequest[];

    try {
      payload = rawBody.length ? (JSON.parse(rawBody) as JsonRpcRequest | JsonRpcRequest[]) : ({} as JsonRpcRequest);
    } catch (err) {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error', data: String(err) },
      });
      return;
    }

    handleRequest(payload)
      .then((response) => sendJson(res, 200, response))
      .catch((err) => {
        const error = normalizeError(err);
        sendJson(res, 200, { jsonrpc: '2.0', id: null, error });
      });
  });

  req.on('error', (err) => {
    const error = normalizeError(err);
    sendJson(res, 500, { jsonrpc: '2.0', id: null, error });
  });
});

server.listen(port, () => {
  console.log(`eth_getLogs chunking proxy listening on http://0.0.0.0:${port}`);
  console.log(`Forwarding to upstream: ${upstreamUrl}`);
  console.log(`Chunk size: ${parsedChunkSize} blocks`);
});
