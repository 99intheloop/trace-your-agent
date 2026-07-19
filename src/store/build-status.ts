/**
 * build-status — 从 TOOL_CALL span 派生"构建/测试是否通过"的客观信号。
 *
 * 设计(捷径版,详见讨论):
 *   - 不解析 exit code。span 的 status.code 在适配器层已统一处理了各平台
 *     工具结果的成败语义,直接复用,避免逐平台文本解析的泥潭。
 *   - 不落库、不做 schema 迁移。状态在查询时从 spans 表现场派生。
 *   - 命令识别 = tool_name 白名单 + input_summary 的 LIKE 模式表。
 *     误报可接受(v1 语义是"检测到测试/构建命令:通过/失败/未运行",
 *     不是质量分)。
 */

export type BuildStatus = 'pass' | 'fail' | 'none';

/** 执行 shell 类命令的工具名(三平台并集)。 */
const SHELL_TOOL_NAMES = ['Bash', 'bash', 'exec_command', 'Shell', 'shell', 'unified_exec'];

/**
 * 测试/构建命令模式(input_summary 小写 LIKE,含通配)。
 * input_summary 形如 `{"command":"cd x && pnpm test 2>&1",...}`。
 */
const COMMAND_PATTERNS = [
  // test runners
  '%npm test%', '%npm run test%', '%pnpm test%', '%pnpm run test%', '%yarn test%',
  '%bun test%', '%vitest%', '%jest%', '%pytest%', '%py.test%', '%cargo test%',
  '%go test%', '%mvn test%', '%gradle%',
  // build / typecheck / lint
  '%npm run build%', '%pnpm build%', '%pnpm run build%', '%yarn build%',
  '%bun run build%', '%tsc%', '%eslint%', '%cargo build%', '%go build%', '%make %',
];

/** SQL 片段:命中"测试/构建类命令"的 span 条件(参数化)。 */
export function buildCommandSql(prefix = 'bc'): { where: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const toolHolders = SHELL_TOOL_NAMES.map((name, i) => {
    const key = `${prefix}_tool${i}`;
    params[key] = name;
    return `@${key}`;
  });
  const patternClauses = COMMAND_PATTERNS.map((pattern, i) => {
    const key = `${prefix}_pat${i}`;
    params[key] = pattern;
    return `LOWER(input_summary) LIKE @${key}`;
  });
  return {
    where: `(tool_name IN (${toolHolders.join(',')})) AND (${patternClauses.join(' OR ')})`,
    params,
  };
}

/** 由 (命令数, 失败数) 归约出状态。 */
export function reduceBuildStatus(commandCount: number, failCount: number): BuildStatus {
  if (failCount > 0) return 'fail';
  if (commandCount > 0) return 'pass';
  return 'none';
}
