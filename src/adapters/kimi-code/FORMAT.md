# kimi-code 磁盘格式纪要(适配器实现依据)

本文记录 kimi-code 两代引擎的本地会话格式,供适配器维护者参考。所有结论都有源码依据(path:line,路径相对公开仓库 moonshot-ai/kimi-code 的 repo 根)。

## §1 会话目录布局

```
<home>/sessions/<workdirKey>/<sessionId>/
  state.json
  agents/<agentId>/wire.jsonl     # agentId 'main' 为主代理
```

- `<home>` = `~/.kimi-code`,或 `KIMI_CODE_HOME` 覆盖(v2 bootstrap:`packages/agent-core-v2/src/app/bootstrap/bootstrapService.ts:82-96`)。
- v1 存储路径拼接:`packages/agent-core/src/session/store/session-store.ts:64-69`(`join(homeDir,'sessions',encodeWorkDirKey(workDir), sessionId)`)。
- 一个 session 目录下每个 agent 一份 wire 日志;`state.json` 记录 agent 元信息(见 §6)。

## §2 wire 协议:单一 1.x 谱系,两代引擎共享

- 首行固定为 `{"type":"metadata","protocol_version":"<x.y>","created_at":<ms>}`(v2 定义:`packages/agent-core-v2/src/wire/record.ts` `WireMetadataRecord`)。
- v1(`packages/agent-core`,当前默认 CLI/TUI 引擎)写 `1.4`;v2(`packages/agent-core-v2`,experimental flag / server 形态)写 `1.5`。`1.0–1.5` 之外视为未知协议,抛 `UnknownWireProtocolError`(仅主 wire;子 wire 跳过)。
- **op 名集合两代同源**(v1 定义:`packages/agent-core/src/agent/records/types.ts:44-142`;v2 对应:`packages/agent-core-v2/src/agent/loop/turnOps.ts`、`agent/contextMemory/contextOps.ts`、`agent/llmRequester/llmRequestOps.ts`):
  - `turn.prompt` / `turn.steer` / `turn.cancel`
  - `context.append_message` / `context.append_loop_event` / `context.update_token_count` / `context.apply_compaction` …
  - `llm.request` / `llm.tools_snapshot`
  - v1 另有 `config.update` / `goal.*` 等(适配器忽略)
- 业务行均为扁平 JSON:`{type, time, ...payload}`(v2 编码:`opToWireRecord`,`packages/agent-core-v2/src/wire/record.ts:50-62`)。

## §3 span 映射

| wire record | span |
|---|---|
| session 目录 | `SESSION`(session.id / kimi.engine / kimi.wire.protocol_version) |
| `turn.prompt` | `AGENT_TURN` 开;`turn.steer` 空闲时也开新 turn;`turn.cancel` → error 关闭 |
| `context.append_loop_event` 内 `step.begin` / `step.end` | `LLM_CALL` 开/闭 |
| 同上内 `tool.call` / `tool.result` | `TOOL_CALL` 开/闭(按 `toolCallId` 配对,挂在 step 下) |
| `context.append_message` | 消息存 payload,挂当前 turn |
| `llm.request` | 按 `turnStep`/`attempt` 回填所在 step 的 provider/model 等 attrs(**无完整 body**,仅有 systemPromptHash/toolsHash 等元数据) |

## §4 step.end 的精确延迟细分(wire 独有,三系统中最细)

`step.end` 携带:`llmFirstTokenLatencyMs` / `llmStreamDurationMs` / `llmRequestBuildMs` / `llmServerFirstTokenMs` / `llmServerDecodeMs` / `llmClientConsumeMs`(v2 定义:`packages/agent-core-v2/src/agent/contextMemory/loopEventFold.ts:54-99`)。适配器把原始值放 attributes,并合成 `first_token` / `stream_end` 两个 span event 定位在 step 时间窗内。

**turn 关闭语义**:`step.end` 的 `finishReason !== 'tool_use'` 时标记 turn 待关闭(`pendingCloseMs`);若后续出现同 agent 的新 `step.begin`(hook 续跑),清除待关闭标记;流结束时统一按 pendingClose 关闭。流尾仍未闭合的 turn/step 交 ingest 管线 `closeAllIncomplete`(中断会话是常态)。

## §5 父子 join(三级证据,诚实标注 joinQuality)

1. **state.json**:`agents[<id>].parentAgentId`(v1 直接字段;v2 直接字段或 `labels.parentAgentId`)→ `joinQuality: 'semi'`,挂 SESSION 下。
2. **工具结果文本**:父 wire 中 `Agent`/`AgentSwarm` 的 `tool.call` 与其 `tool.result` 配对,从输出提取 `agent_id: agent-N`(或 XML `agent_id="..."`)→ 子 turn 挂到该 TOOL_CALL span 下(需挂载时工具 span 仍打开,即子 turn 时间落在调用窗口内),`'semi'`;`args.run_in_background === true` → 子树 `detached: true`。
3. **纯时序兜底**:子 wire 首条记录恰好落在唯一一个 Agent 调用窗口内 → `'heuristic'`。
4. 皆无 → 孤儿(不设 parentSpanId)。

**后台任务通知**:`context.append_message` 或 `turn.steer` 且 `origin.kind === 'background_task'` → 记 `NOTIFY` link(父 turn ← 子树),子树标 `detached`。`Agent(resume="agent-N")` 的调用与该 agent 后续 turn 配对(`'semi'`)。

## §6 state.json 两代差异

| 字段 | v1 | v2 |
|---|---|---|
| 版本标记 | 无 | 顶层 `version: 2` |
| 工作目录 | `workDir` | `cwd` |
| 创建时间 | `createdAt`(ISO 字符串) | `createdAt`(ms 数字) |
| agents[id] | `type`/`parentAgentId` 等 | `parentAgentId`/`labels`/`swarmItem`,均可选 |

适配器对两代表都宽容读取(见 `session-dir.ts`);引擎判定:`version === 2` → v2,否则按 wire 协议版本(1.4→v1,1.5→v2)。
