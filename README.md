# dsh-llm-sub2api-dsml

DeepSeek Harness（DSH）的 DSML 兼容插件。当 DeepSeek 经 Sub2API 等渠道把工具调用输出成 reasoning / text 中的 DSML 文本时，将完整合法的调用转换成 DSH 原生工具事件，让 Agent Loop 继续运行。

作者：wwj · 许可证：[MIT](LICENSE)

```text
现有 LLM provider → reasoning / text 中的 DSML
→ 流式缓冲 → 当前工具 schema 校验 → DSH tool-call
→ finish(kind=tool-calls) → DSH 权限检查与工具执行
```

插件根据模型 ID 自动匹配任意 provider 的流，直接使用原模型分组，不需要切换模型或填写提供商列表。原适配器继续处理上游协议、SSE、认证、附件和历史序列化；本插件不保存密钥。

## 兼容要求

- DSH：当前仅验证并声明支持 `0.2.1-rc.3`。
- Node.js：`>=22.19.0`，CI 覆盖 Node.js 22.19.0 与 24。
- 已配置并可用的 LLM provider；其模型 ID 包含 `deepseek`（不区分大小写）。
- 不限定提供商或上游协议；`deepseek-v4.1-flash`、`prefix/DeepSeek-R1` 等模型 ID 均自动匹配。插件不创建上游连接，也不提供模型或凭据配置。

## 安装

克隆本仓库后，在源码目录安装依赖、测试并生成安装包：

```bash
git clone https://github.com/Nicolas-One/dsh-llm-sub2api-dsml.git
cd dsh-llm-sub2api-dsml
npm install --ignore-scripts
npm test
npm pack
dsh plugin --profile web add ./dsh-llm-sub2api-dsml-1.0.0.tgz
```

`web` 替换为目标 profile。包已包含 JavaScript 入口和 `dsh.bundle` 配置层，无需构建。安装与配置层机制见 [DSH 官方插件打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)。

安装并加载后，任意已有 provider 下模型 ID 包含 `deepseek` 的请求都会自动参与检测（不区分大小写）。不需要填写提供商名称，模型 ID 中没有 `deepseek` 的别名不会被识别；正常响应保持原样，检测到完整合法 DSML 才转换。

如需关闭转换或调整缓冲上限，可将下面配置合并到 `$DSH_HOME/profiles/web/cordis.patch.yml` 的顶层数组中：

```yaml
- id: sub2api-dsml
  config:
    dsmlCompatibility: true
    maxBufferChars: 1048576
```

已有其他配置时保留其数组项。此行覆盖 bundle 插入的插件配置，无需再添加 `insert`；覆盖会替换整个 `config`，请完整保留上述字段。可复制 [配置示例](examples/cordis.patch.yml)。

使用 `dsh --profile web --dump-config` 检查最终配置。让目标实例加载新配置后，继续选择原 provider 下的 DeepSeek 模型即可。是否可热加载取决于宿主，安排重启时应先结束正在运行的任务；已开始的请求不会被转换。

若之前手动挂载过同名插件，请先统一安装方式，避免重复插件行和内部路由冲突。

## 配置项

| 字段 | 说明 |
| --- | --- |
| `dsmlCompatibility` | 默认 `true`；设为 `false` 关闭转换。 |
| `maxBufferChars` | DSML 缓冲上限，默认 `1048576` 字符，允许 `1024` 到 `8388608`。 |

自动检测仅根据模型 ID，辅助请求（`purpose` 非空）直接透传。新注册的 provider 同样生效，无需重新维护提供商名单。

升级旧配置时，`compatibleProviders` 字段仍可被读取，但不再限制模型匹配，可以删除。`sourceProvider` 默认留空，默认不注册额外路由；只有需要继续使用旧内部路由的会话才显式填写实际源 provider ID。此时可通过 `provider` 指定内部路由 ID（默认 `sub2api-deepseek-dsml`），不得与源路由或其他已注册路由冲突。内部路由不发布模型列表，普通会话始终使用原 provider。

## 解析行为与限制

- 支持跨 SSE 分片的标签、reasoning / text，以及最终 `block-end` 权威文本。
- 只识别独立成行、代码围栏外的 `<｜DSML｜ calls>` 或 `<｜DSML｜ tool_calls>` 根节点；行内示例、代码围栏和无根 XML 不会被执行。
- 支持多个 `invoke`、带或不带 DSML 前缀的内部标签、单双引号属性、字符串与 JSON 参数。
- 按当前请求声明的工具 schema 校验。未知工具、重复参数、缺参、非法 JSON 或类型不符会失败，不猜测参数或补全闭合标签。
- 每段最多 64 个调用，每个调用生成独立 ID；具体可用工具取决于当前请求声明。
- 完整合法 DSML 到达后立即关闭上游流并提交调用，调用段后的生成不再读取；多工具应放在同一根节点中。
- 若原生工具调用先到，不再转换 DSML，避免重复提交。
- DSML 闭合前的取消、错误或截断不产生工具调用；未闭合调用遇到正常结束返回 `DSML_INVALID_CALL`。
- 插件只产生原生事件，工具执行与权限检查由 DSH 负责。它无法恢复已结束的历史回合。
- 主动结束可能收不到最终 usage，只保留已收到的用量，不伪造完整计费数据。
- 修改响应后丢弃旧 `replayState`，下一次请求由原适配器按标准历史序列化；日志只记录状态和调用数量。

**本插件不设置推理强度，也不解决所有 thinking 历史回传问题。** Sub2API 的推理强度显示、`output_config.effort` 映射，以及 `content[].thinking must be passed back` 等问题，需要另行核对上游协议与原适配器配置。

## 开发与验证

```bash
npm install --ignore-scripts
npm test
npm pack --dry-run
```

测试使用真实 Cordis、`LlmRuntime`、`BlockAssembler` 和官方 `dsh-llm-pi-ai`，连接本地模拟 HTTP/SSE。覆盖分片、多工具、参数拒绝、主动关闭、工具结果回传、冷启动和卸载；工具执行使用无害替身，无需真实密钥，也不运行 shell。

`test/replay.mjs` 从标准输入读取本地消息与工具 schema，仅解析和组装，不执行工具。不要将真实会话、命令或凭据提交到仓库。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

GitHub Actions 执行依赖安装、测试和打包检查，不自动发布 npm 或部署 DSH。`private: true` 用于防止误发 npm，不影响 GitHub 上的 MIT 开源和 tarball 安装。问题反馈请提交到 [GitHub Issues](https://github.com/Nicolas-One/dsh-llm-sub2api-dsml/issues)。

当前未提交锁文件，依赖解析可能随兼容版本更新而变化；新安装以 CI 的测试结果为准。

## 卸载

确认旧会话不再使用隐藏路由后，删除 profile 中的 `sub2api-dsml` 覆盖配置，再移除 bundle：

```bash
dsh plugin --profile web remove dsh-llm-sub2api-dsml
```

## 许可证

[MIT License](LICENSE)，Copyright (c) 2026 wwj。
