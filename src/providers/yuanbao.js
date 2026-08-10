import { OpenAICompatibleProvider } from './openai.js';

// 腾讯元宝（Yuanbao）网关：OpenAI 兼容协议。
// 默认 base URL 为 https://yuanbao.tencent.com/api，
// 端点 = baseUrl + /chat/completions => https://yuanbao.tencent.com/api/chat/completions
// （端口自 acplugin：DEFAULT_YUANBAO_BASEURL='https://yuanbao.tencent.com' + endpoint '/api/chat/completions'）
export const DEFAULT_YUANBAO_BASEURL = 'https://yuanbao.tencent.com/api';

export class YuanBaoProvider extends OpenAICompatibleProvider {
  constructor(cfg) {
    super({ ...cfg, baseUrl: cfg.baseUrl || DEFAULT_YUANBAO_BASEURL });
    this.type = 'yuanbao';
    this.name = cfg.name || '元宝';
  }
}
