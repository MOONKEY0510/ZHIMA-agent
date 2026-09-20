/** One built-in provider preset. Selecting a preset in the "添加服务商" form
 * fills the display name and the OpenAI-compatible base URL so users only
 * need to paste an API key. */
export interface ProviderPreset {
  id: string;
  /** Display name, also used as the default provider name. */
  name: string;
  /** OpenAI-compatible base URL. */
  baseUrl: string;
  /** Vendor console page where the API key can be created. */
  consoleUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    consoleUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "glm",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    consoleUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    consoleUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
  },
  {
    id: "moonshot",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.cn/v1",
    consoleUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "qwen",
    name: "通义千问 (Qwen)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    consoleUrl: "https://bailian.console.aliyun.com/",
  },
  {
    id: "siliconflow",
    name: "硅基流动 (SiliconFlow)",
    baseUrl: "https://api.siliconflow.cn/v1",
    consoleUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "volcengine",
    name: "火山方舟 (豆包)",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    consoleUrl: "https://console.volcengine.com/ark",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    consoleUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    consoleUrl: "https://openrouter.ai/keys",
  },
  {
    id: "ollama",
    name: "本地 Ollama",
    baseUrl: "http://localhost:11434/v1",
  },
];
