# trace-your-agent (`tya`)

**把你的 AI agent 会话变成一棵可点的 span 树。** 读取 Claude Code / Codex / Kimi Code 在你本机产生的会话记录，统一成 span 树，本地终端 + 本地 Web UI 查看。数据不出本机。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-43853d)](package.json)

<!-- 效果图占位:![span 树截图](docs/screenshot.png) -->

## 30 秒上手

要求 Node.js ≥ 20，无需安装：

```bash
npx trace-your-agent doctor     # ① 体检:看看你机器上有哪些 agent 数据
npx trace-your-agent ingest     # ② 采集:会话文件 → span 树(增量,可反复跑)
npx trace-your-agent serve      # ③ 打开本地 Web UI → http://127.0.0.1:4777
```

不想开浏览器？终端里也能看：

```bash
npx trace-your-agent sessions                       # 列出所有会话
npx trace-your-agent show <sessionId>               # ASCII span 树
npx trace-your-agent export <sessionId> --format html   # 导出单文件 HTML,发给同事就能看
```

从源码运行：`git clone` 后 `npm install && npm run build`，然后 `npx tya --help`。

## 支持的平台

| 平台 | 数据源（严格只读） | LLM 时长精度 |
| --- | --- | --- |
| Claude Code | `~/.claude` 会话记录 | ≈ 推算（标记 `approx`) |
| Codex | `~/.codex` rollout 记录 | ≈ 推算（标记 `approx`) |
| Kimi Code(v1 + v2) | `~/.kimi-code` wire 记录 | ✅ 精确（首 token/流式/解码细分） |

## 你能看到什么

- **Web UI**：按平台（Claude Code / Kimi Code / Codex）过滤的会话列表、每会话聚合的 token/成本/错误、可折叠的 span 树、节点详情（参数/结果/延迟事件）、全文搜索
- **子代理关系**：父子挂载按证据强度标注 `structural / semi / heuristic`，后台子代理标 `⏚ detached`，完成通知建 `NOTIFY` link，挂不上就是孤儿——绝不编造
- **中断的会话**：流尾未闭合的 span 标 `⚠ incomplete`，不装死
- **成本估算**：内置价格表（**估算值，以官方价格为准**)

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `tya doctor` | 探测三个 agent 的家目录（版本/可读性/文件数） |
| `tya ingest [--source cc\|codex\|kimi]` | 采集（增量、幂等） |
| `tya sessions [--source ...]` | 列出会话（含 token/成本/错误） |
| `tya show <id>` | 终端 ASCII span 树 |
| `tya export <id> [--format ndjson\|html]` | 导出（HTML 自包含、已脱敏、可直接分享） |
| `tya serve [--port n] [--no-open]` | 本地 Web UI([API 契约](docs/api.md)) |
| `tya prune --older <days>` | 清理过期 payload |
| `tya install-hooks claude-code` | （可选）安装 CC hook，把子代理 join 从"推断"升级为"精确"；写入前自动备份，`uninstall-hooks` 无残留移除 |

数据只写入 `~/.trace-your-agent/`（环境变量 `TYA_HOME` 可覆盖）。

## 隐私

1. **纯本地、零遥测**，不联网。
2. **对 agent 家目录严格只读**（唯一例外：显式 `install-hooks`，且先备份）。
3. **密钥脱敏默认开启**:`sk-ant-*`、`ghp_*`、`AKIA*`、`Bearer` 等一律 `[REDACTED]` 后才落盘。
4. HTML 导出**不含 payload 全文**，只有脱敏后的摘要——你看到的即接收者能看到的。

## 已知限制（摘要）

- CC / Codex 的 LLM 调用时长是推算值（源文件不记 API 边界）;kimi 的 `llm.request` 不含完整请求/响应 body
- 父子关系靠三级证据降级匹配，`heuristic` 级可能挂错——UI 会如实标注
- 详细说明：[docs/limitations.md](docs/limitations.md) · kimi 格式细节：[src/adapters/kimi-code/FORMAT.md](src/adapters/kimi-code/FORMAT.md)

## 开发

```bash
npm install && npm run build   # tsup(CLI) + vite build(UI)
npm test                       # vitest,166 个测试
npm run typecheck              # tsc strict
```

加新适配器：实现 [src/core/source.ts](src/core/source.ts) 的 `Adapter` 契约（`detect` / `discover` / `parse`)，在 `src/adapters/registry.ts` 注册。

## Roadmap

- `ingest --follow` 实时尾随 · 泳道视图（按 agent 分道） · OTLP 导出 · Codex rollout-trace bundle · 代理模式

## License

MIT
