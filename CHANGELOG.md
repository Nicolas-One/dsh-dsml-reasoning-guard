# 更新记录

## 1.0.0

- 将 reasoning / text 中完整且符合工具 schema 的 DSML 转换为 DSH 原生工具调用。
- 支持跨分片解析、多工具调用和现有 provider 流拦截，不增加模型选择分组。
- 保留隐藏兼容路由，支持已有会话继续使用。
- 增加 MIT 许可证、DSH bundle、通用配置示例和 GitHub CI。
- 按模型 ID 中的 `deepseek` 自动匹配所有提供商，无需配置提供商列表；默认不注册内部兼容路由。
