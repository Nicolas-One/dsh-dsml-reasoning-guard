/**
 * 恢复 DeepSeek 泄漏到思考中的完整 DSML 调用，并清洗协议标签。
 * 转换后的调用仍由 dsh 校验、审批和执行，本插件不执行工具。
 * @author wwj
 */
import { guardStream } from './stream.js';

export const name = 'dsh-dsml-reasoning-guard';
export const inject = ['llm'];

export function apply(ctx) {
  // 注入 llm 使监听器与服务作用域匹配，ctx.on 随插件卸载自动清理。
  ctx.on('llm/stream', (options, next) => {
    const stream = next(options);
    if (typeof options.model !== 'string' || !/deepseek/i.test(options.model)) return stream;
    return guardStream(stream, options, (event) => {
      ctx.logger.info(`[dsml-reasoning-guard] ${event} model=${options.model}`);
    });
  });
  ctx.logger.info('[dsml-reasoning-guard] ready');
}
