# 精度与已知限制(详版)

trace 的诚实性比好看更重要:凡是推算出来的,span 上都带标记。

## `joinQuality` 三级

- `structural`:源格式里有显式父子 id
- `semi`:由强结构推导(嵌套、tool_use 配对、state.json 元数据)
- `heuristic`:仅凭时序/文本匹配,可能挂错
- 三级都挂不上则为孤儿——不写 `parentSpanId`,不标注,绝不编造父子关系

## Claude Code

- `LLM_CALL` 时长为推算值(与同一 agent 前一行的时间差,`approx: true`),不是真实 API 延迟;transcript 不记录 API 边界,这是源格式的固有限制
- 子代理 join:`agent-*.meta.json` 显式字段 / `joins.jsonl` sidecar(install-hooks 提供)为 `structural`;prompt 文本匹配(±10 分钟)为 `heuristic`
- sidechain 内没有 `turn_duration` 行,同步子代理的 turn 以主文件 Task `tool_result` 时间闭合
- 异步(后台)子代理仅在同时检测到 task id 形态的结果和 `<task-notification>` 时才标 detached(保守,不误标)

## Codex

- 一个线程一个 rollout 文件;子代理是独立线程文件。适配器分两阶段:先单文件解析,再跨文件把子线程挂回父线程的 `spawn_agent` 工具 span,整棵线程树聚合成一个会话
- `LLM_CALL` 为近似段(reasoning + 后续 message/function_call 合成,`approx: true`);精确的逐请求 span 需 rollout-trace bundle(见 README Roadmap)
- 跨文件 join:父文件 `collab_agent_spawn_end` 事件携子线程 id 为 `structural`;spawn 参数/输出文本含子线程 id 或 nickname 为 `semi`;仅 `parent_thread_id` + 时间窗为 `heuristic`
- fork 线程挂到来源线程 SESSION 下并标 `codex.forkedFrom`

## Kimi Code

- wire 记录里 `llm.request` 不含完整 LLM 请求/响应 body(只有 systemPromptHash/toolsHash 等元数据);消息内容以 `context.append_message` 为准
- 两代引擎均支持:v1(当前默认 CLI/TUI 引擎,wire 1.4)与 v2(wire 1.5);`state.json` 两代表宽容读取。格式细节见 [../src/adapters/kimi-code/FORMAT.md](../src/adapters/kimi-code/FORMAT.md)
- 中断是常态:流尾未闭合的 turn/step 以 `incomplete: true` 收尾

## 成本估算

内置价格表会过时,所有 `$` 数字都是估算;新型号按同档估价(表中注明 estimate)。以各官方价格页面为准。
