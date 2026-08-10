import { OpenAICompatibleProvider } from './openai.js';

// acplugin 网关：OpenAI 兼容协议（端口自 acplugin 项目）。
// 默认 base URL 见 DEFAULT_ACPLUGIN_BASEURL（acplugin 项目实际使用的网关端点）。
export const DEFAULT_ACPLUGIN_BASEURL = 'https://yuanbao.tencent.com/api';

export class AcpluginProvider extends OpenAICompatibleProvider {
  constructor(cfg) {
    super({ ...cfg, baseUrl: cfg.baseUrl || DEFAULT_ACPLUGIN_BASEURL });
    this.type = 'acplugin';
    this.name = cfg.name || 'Acplugin';
  }
}
