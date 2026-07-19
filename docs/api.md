# tya 本地 API 契约(server 与 ui 的共同依据,勿偏离)

Base:`http://127.0.0.1:<port>`(默认 4777)。全部 JSON。错误:`{ "error": "<message>" }` + 合适状态码。

## REST

- `GET /api/health` → `{ ok: true }`
- `GET /api/sessions?source=&q=&limit=&offset=`
  - `source` ∈ `claude-code|codex|kimi-code`(可选);`q` 对 cwd/sessionId 子串过滤(可选);`limit` 默认 50,`offset` 默认 0
  - → `{ sessions: SessionSummary[], total: number }`
- `GET /api/sessions/:sessionId` → `SessionSummary`(404 若不存在)
- `GET /api/sources` → `{ sources: Array<{ source: string; count: number }>, total: number }`(各平台 session 计数,驱动 UI 过滤 tab)
- `GET /api/sessions/:sessionId/spans` → `{ spans: Span[], links: Link[] }`(span 含 `parentSpanId`;前端自行组树)
- `GET /api/search?q=&source=&limit=`(q 必填)→ `{ results: SearchHit[] }`,`SearchHit = { spanId, sessionId, kind, name, toolName?, snippet, startTimeMs }`(走 FTS5,snippet 来自 name/inputSummary/outputSummary)
- `GET /api/payloads/:ref` → payload 原始 JSON(404 若不存在;ref 即 span.payloadRef,不含 `payloads/` 前缀)

## 类型(与 src/core/types.ts 及 src/store 对齐)

```ts
Span = {
  traceId: string; spanId: string; parentSpanId?: string;
  kind: 'SESSION'|'AGENT_TURN'|'LLM_CALL'|'TOOL_CALL';
  name: string; startTimeMs: number; durationMs: number;
  status: { code: 'ok'|'error'; message?: string };
  attributes: Record<string, string|number|boolean>;
  events?: { name: string; timestampMs: number; attributes?: Record<string,string|number|boolean> }[];
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  toolName?: string; inputSummary?: string; outputSummary?: string;
  agentName?: string; payloadRef?: string;
}
Link = { fromSpanId: string; toSpanId: string; kind: 'NOTIFY'|'MESSAGE' }
SessionSummary = {
  sessionId: string; source: string; cwd?: string; startedAtMs?: number;
  spanCount: number; agentCount: number; turnCount: number;
  totalInputTokens: number; totalOutputTokens: number;
  totalCostUsd: number; errorCount: number;
  joinQualityStats: Record<string, number>;
}
```

## 静态托管

server 托管 `dist/ui/`(Vite 构建产物):非 `/api/*` 的 GET 一律回退 `index.html`(SPA history 路由)。UI 内路由:`/`→重定向 `/sessions`;`/sessions`;`/sessions/:sessionId`。

## CLI

`tya serve [--port <n>] [--home <dir>] [--no-open]` — 起服务,默认尝试开浏览器(`open` 命令,macOS;失败仅警告)。
