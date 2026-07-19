# tya 本地 API 契约(server 与 ui 的共同依据,勿偏离)

Base:`http://127.0.0.1:<port>`(默认 4777)。全部 JSON。错误:`{ "error": "<message>" }` + 合适状态码。

## REST

- `GET /api/health` → `{ ok: true }`
- `GET /api/sessions?source=&q=&limit=&offset=&cwd=&from=&hasError=`
  - `source` ∈ `claude-code|codex|kimi-code`(可选);`q` 对 cwd/sessionId 子串过滤(可选);`limit` 默认 50,`offset` 默认 0
  - `cwd`(可选):路径前缀过滤——匹配该目录本身或其子目录(boundary-aware)
  - `from`(可选):epoch ms,只返回开始时间 ≥ 该值的 session
  - `hasError`(可选):`1|true` 只看有错误,`0|false` 只看无错误
  - `build`(可选):`pass|fail|none` 按派生构建/测试状态过滤(命令模式 + span 状态,查询时从 spans 派生,不落库)
  - `spanQ`(可选):span 全文过滤——只返回包含命中 span 的 session(FTS 联查,分页正确);命中时每个 SessionSummary 附 `spanHits`(命中 span 数)
  - → `{ sessions: SessionSummary[], total: number }`;每个 SessionSummary 附 `buildStatus`
- `GET /api/cwds?source=` → `{ cwds: Array<{ cwd: string; count: number }> }`(distinct cwd + 计数,按计数降序,驱动级联选择器)
- `GET /api/sessions/:sessionId` → `SessionSummary`(404 若不存在)
- `GET /api/sources` → `{ sources: Array<{ source: string; count: number }>, total: number }`(各平台 session 计数,驱动 UI 过滤 tab)
- `GET /api/sessions/:sessionId/spans` → `{ spans: Span[], links: Link[] }`(span 含 `parentSpanId`;前端自行组树)
- `GET /api/search?q=&source=&limit=`(q 必填)→ `{ results: SearchHit[] }`,`SearchHit = { spanId, sessionId, kind, name, toolName?, snippet, matchedField?, cwd?, source?, startTimeMs }`(走 FTS5;**按 session 去重**——每个 session 只返回一条代表命中,内部多拉 10 倍再截 limit;snippet 固定 20 字符以命中词居中;matchedField ∈ input|output|name;cwd 为所属 session 工作目录;source 为平台)
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
