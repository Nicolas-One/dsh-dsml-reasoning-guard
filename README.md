# dsh-dsml-reasoning-guard

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

用于 dsh 的 DeepSeek 流式输出修复插件：恢复泄漏到 reasoning 中的完整 DSML 工具调用，并隐藏误出现在可见文本中的 `<think>...</think>` 思考段。

## 兼容性

- dsh `0.2.1-rc.2`
- Node.js ESM

插件依赖 dsh 的 `llm/stream` 事件和标准 `StreamChunk` 契约。dsh 版本超出上述范围时，请先在隔离 profile 中验证；不要静默忽略版本兼容性检查。

## 安装

在 dsh profile 的插件目录中安装：

```bash
dsh plugin --profile web add https://github.com/Nicolas-One/dsh-dsml-reasoning-guard.git
```

或将本仓库目录放入 profile 的 `local-plugins`，并在 profile 配置中启用 `dsh-dsml-reasoning-guard`。安装后重启 profile，或使用已启用的 dsh HMR。

作者：wwj

修复 DeepSeek 将工具调用写进思考文本后，dsh 直接结束回合的问题。ESM 入口通过 `inject: ['llm']` 注册 `llm/stream`，监听器随插件卸载清理。

恢复条件必须同时满足：

- DeepSeek 请求正常以 `stop` 结束，未取消，且不是标题生成等辅助请求。
- 本次响应没有原生工具调用和非空正文，最后一个块是思考。
- 思考末尾存在独立成行、完整闭合的 DSML `calls` 或 `tool_calls` 段，且不在代码围栏中。
- 工具名在当前请求的 `tools` 中声明；参数不重复、JSON 有效、必填参数齐全。

恢复生成标准 `block-start`、`tool-call-delta`、`block-end`，并将结束原因改为 `tool-calls`。工具执行仍由 dsh 的校验、权限与审批链路处理，插件本身不执行参数中的代码。

完整 DSML 根内的 invoke、parameter 可以混用带前缀与裸标签。`string="true"` 参数保留原文；没有 string 属性时，只有当前工具 schema 明确声明为 string 的参数才保留原文，其他参数按 JSON 解析。没有完整外层的历史残片不会被猜测成调用。

清洗同时覆盖跨分片 delta 和权威的 `block-end`。无法恢复的思考尾部 DSML 调用保留完整块原文，并返回 `DSML_UNRECOVERABLE` 错误，避免静默成功。正常正文里的裸 XML 标签保持原样。

改变内容后移除过期 `replayState`，避免沿用原始签名或错误的块对齐信息。普通响应保留原始回放元数据，上游异常原样传播。调用捕获上限为 2,097,152 个字符；超过上限不执行不完整调用。

如果可见 `text` 块从块首开始出现 `<think>...</think>`，插件会隐藏思考段并保留闭合标签后的答案。非块首的普通正文示例保持原样。

## 验证

在插件目录运行：

```bash
npm test
node test/host.mjs /path/to/dsh/node_modules
```

宿主集成验证使用实际 Cordis、BlockAssembler 和 profile 中已安装的 artifact guard。可给 `test/host.mjs` 的第二个参数传入实际会话样本 JSON，回放仅组装调用，不执行历史代码。

修改源码后需触发 profile 热重载。仅编辑源码是否自动重载取决于当前 HMR 的 `root` 设置，不能只凭文件保存成功判断已经启用；应检查插件管理器的 `fiberPhase` 是否为 `active`。

## 许可证

本项目采用 [MIT License](./LICENSE)。
