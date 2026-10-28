/** 全新的 DSML 兼容插件，使用官方 adapter 注册和流拦截接口。@author wwj */
import z from '@deepseek-ai/schemastery';
import { Sub2ApiDsmlAdapter } from './adapter.js';
import { convertDsml } from './stream.js';

export const name = 'llm-sub2api-dsml';
export const inject = ['llm'];
export const Config = z.object({
  dsmlCompatibility: z.boolean().default(true),
  provider: z.string().default('sub2api-deepseek-dsml'),
  // 仅为旧会话显式配置兼容路由；自动纠正不依赖任何提供商。
  sourceProvider: z.string().default(''),
  // 接受旧配置以便升级，但不再用提供商列表限制模型匹配。
  compatibleProviders: z.array(z.string()).default([]),
  maxBufferChars: z.number().default(1048576),
});

export function apply(ctx, rawConfig) {
  const config = Config(rawConfig);
  if (config.provider === config.sourceProvider) throw new Error('独立 provider 不能覆盖 sourceProvider');
  if (!Number.isSafeInteger(config.maxBufferChars) || config.maxBufferChars < 1024
    || config.maxBufferChars > 8 * 1048576) throw new Error('maxBufferChars 必须在 1024 到 8388608 之间');
  const bypass = new WeakSet();
  const wrap = (source, options) => !config.dsmlCompatibility || options.purpose || !/deepseek/i.test(options.model)
    ? source : convertDsml(source, options, {
    maxBufferChars: config.maxBufferChars,
    report: (event) => {
      // 只记录状态和数量，不把命令、参数或密钥写到日志。
      const suffix = event.status === 'recovered' ? ` count=${event.count}` : '';
      ctx.logger.info(`[sub2api-dsml] ${event.status}${suffix}`);
    },
  });
  ctx.on('llm/stream', (options, next) => {
    if (bypass.has(options)) return next();
    return wrap(next(), options);
  });
  const dispatch = (options) => {
    bypass.add(options);
    return wrap(ctx.llm.stream(options), options);
  };
  let registration;
  let registering = false;
  const registerWhenReady = () => {
    if (!config.sourceProvider || registration || registering
      || !ctx.llm.listProviders().some((provider) => provider.id === config.sourceProvider)) return;
    // 冷启动时源适配器可能稍后才注册；避免提前读取其重试策略而加载失败。
    // registerAdapter 会同步通知拓扑变化，必须防止监听器递归注册。
    registering = true;
    try {
      registration = ctx.llm.registerAdapter([config.provider],
        new Sub2ApiDsmlAdapter(ctx.llm, config.sourceProvider, dispatch));
      ctx.logger.info(`[sub2api-dsml] ready provider=${config.provider} compatibility=${config.dsmlCompatibility}`);
    } finally { registering = false; }
  };
  if (config.sourceProvider) {
    ctx.on('llm/adapters-updated', registerWhenReady);
    registerWhenReady();
  }
}
