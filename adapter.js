/** 兼容已保存的旧路由；不在模型目录展示独立组。@author wwj */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export class Sub2ApiDsmlAdapter extends LlmAdapter {
  constructor(llm, sourceProvider, dispatch) {
    super();
    this.llm = llm;
    this.sourceProvider = sourceProvider;
    this.dispatch = dispatch;
  }

  providerInfo(provider) { return { id: provider, name: 'Sub2API DeepSeek DSML' }; }

  providerRetryPolicy() { return this.llm.providerRetryPolicy(this.sourceProvider); }

  // 模型选择使用原 provider；旧会话仍可按精确模型 ID 解析和继续请求。
  async listModels() { return []; }

  async resolveModel(provider, model, signal) {
    if (!/deepseek/i.test(model)) throw new Error('DSML provider 仅接受 DeepSeek 模型');
    return { ...await this.llm.resolveModelInfo(this.sourceProvider, model, signal), provider };
  }

  imageRequestPricing(_provider, model) {
    return this.llm.imageRequestPricing(this.sourceProvider, model);
  }

  imageRequestTarget(_provider, model, image) {
    return this.llm.imageRequestTarget(this.sourceProvider, model, image);
  }

  stream(options) { return this.dispatch({ ...options, provider: this.sourceProvider }); }
}
