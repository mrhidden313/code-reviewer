import { 
  ExtensionConfig, 
  GeminiContent, 
  GeminiFunctionDeclaration, 
  GeminiGenerateContentResponse, 
  GeminiPart, 
  ToolCall 
} from './types';
import { TOOL_DECLARATIONS } from './tools';

export interface GeminiResponse {
  text: string;
  toolCalls: ToolCall[];
  rawParts: GeminiPart[];
}

export class GeminiClient {
  private config: ExtensionConfig;

  constructor(config: ExtensionConfig) {
    this.config = config;
  }

  public updateConfig(config: ExtensionConfig): void {
    this.config = config;
  }

  public async generateTurn(
    systemPrompt: string,
    history: GeminiContent[],
    signal?: AbortSignal,
    tools: GeminiFunctionDeclaration[] = TOOL_DECLARATIONS
  ): Promise<GeminiResponse> {
    if (!this.config.geminiApiKey) {
      throw new Error('Google Gemini API Key is missing. Please set it in Settings under localRobin.geminiApiKey.');
    }

    const isOpenAiEndpoint = this.isOpenAiCompatible();
    if (isOpenAiEndpoint) {
      return await this.callOpenAiFormat(systemPrompt, history, signal, tools);
    } else {
      return await this.callGeminiNativeFormat(systemPrompt, history, signal, tools);
    }
  }

  private isOpenAiCompatible(): boolean {
    const base = this.config.baseUrl.toLowerCase();
    return base.includes('/v1') || base.includes('openai') || base.includes('openrouter');
  }

  /**
   * Native Google Gemini REST Endpoint
   * https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
   */
  private async callGeminiNativeFormat(
    systemPrompt: string,
    history: GeminiContent[],
    signal?: AbortSignal,
    tools: GeminiFunctionDeclaration[] = TOOL_DECLARATIONS
  ): Promise<GeminiResponse> {
    const model = this.config.model || 'gemini-2.5-flash';
    let base = this.config.baseUrl || 'https://generativelanguage.googleapis.com';
    base = base.replace(/\/+$/, '');
    
    // Construct valid Gemini v1beta URL
    const url = `${base}/v1beta/models/${model}:generateContent?key=${this.config.geminiApiKey}`;

    // Map history to Gemini API structure (role must strictly be 'user' or 'model')
    const geminiContents = history.map((msg) => {
      const role = msg.role === 'model' ? 'model' : 'user';

      return {
        role,
        parts: msg.parts.map((p) => {
          if (p.functionResponse) {
            return {
              functionResponse: {
                name: p.functionResponse.name,
                response: p.functionResponse.response,
              },
            };
          }
          if (p.functionCall) {
            const fc = p.functionCall;
            const sig = p.thought_signature || p.thoughtSignature || 'skip_thought_signature_validator';
            return {
              thought_signature: sig,
              functionCall: {
                name: fc.name,
                args: fc.args || {},
              },
            };
          }
          return { text: p.text || '' };
        }),
      };
    });

    const requestBody = {
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      contents: geminiContents,
      tools: [
        {
          functionDeclarations: tools.map((td) => ({
            name: td.name,
            description: td.description,
            parameters: {
              type: td.parameters.type.toLowerCase(),
              properties: td.parameters.properties,
              required: td.parameters.required,
            },
          })),
        },
      ],
      generationConfig: {
        temperature: 0.2,
      },
    };

    let retries = 0;
    const maxRetries = 3;

    while (true) {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (response.status === 429 && retries < maxRetries) {
        retries++;
        const backoffMs = Math.pow(2, retries) * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as GeminiGenerateContentResponse;
      if (data.error) {
        throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
      }

      const candidate = data.candidates?.[0];
      if (!candidate || !candidate.content) {
        return { text: '', toolCalls: [], rawParts: [] };
      }

      const parts = candidate.content.parts || [];
      let textResult = '';
      const toolCalls: ToolCall[] = [];

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part.text) {
          textResult += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${i}`,
            name: part.functionCall.name,
            args: part.functionCall.args || {},
          });
        }
      }

      return {
        text: textResult,
        toolCalls,
        rawParts: parts,
      };
    }
  }

  /**
   * OpenAI-compatible format support for custom proxies or gateways
   */
  private async callOpenAiFormat(
    systemPrompt: string,
    history: GeminiContent[],
    signal?: AbortSignal,
    tools: GeminiFunctionDeclaration[] = TOOL_DECLARATIONS
  ): Promise<GeminiResponse> {
    let base = this.config.baseUrl.replace(/\/+$/, '');
    if (!base.endsWith('/chat/completions')) {
      base = `${base}/chat/completions`;
    }

    const messages: Array<{
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
      tool_call_id?: string;
    }> = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of history) {
      if (msg.role === 'user') {
        const hasToolResp = msg.parts.find((p) => p.functionResponse);
        if (hasToolResp && hasToolResp.functionResponse) {
          messages.push({
            role: 'tool',
            content: JSON.stringify(hasToolResp.functionResponse.response),
            tool_call_id: `call_${hasToolResp.functionResponse.name}`,
          });
        } else {
          messages.push({
            role: 'user',
            content: msg.parts.map((p) => p.text || '').join('\n'),
          });
        }
      } else if (msg.role === 'model') {
        const functionCalls = msg.parts.filter((p) => p.functionCall);
        if (functionCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: functionCalls.map((fc, idx) => ({
              id: `call_${fc.functionCall!.name}_${idx}`,
              type: 'function',
              function: {
                name: fc.functionCall!.name,
                arguments: JSON.stringify(fc.functionCall!.args || {}),
              },
            })),
          });
        } else {
          messages.push({
            role: 'assistant',
            content: msg.parts.map((p) => p.text || '').join('\n'),
          });
        }
      }
    }

    const openAiTools = tools.map((td) => ({
      type: 'function',
      function: {
        name: td.name,
        description: td.description,
        parameters: {
          type: td.parameters.type.toLowerCase(),
          properties: td.parameters.properties,
          required: td.parameters.required,
        },
      },
    }));

    const response = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.geminiApiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        tools: openAiTools,
        temperature: 0.2,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI-compatible endpoint error (${response.status}): ${errorText}`);
    }

    interface OpenAiCompletionResponse {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
      }>;
    }

    const data = (await response.json()) as OpenAiCompletionResponse;
    const choice = data.choices?.[0]?.message;
    if (!choice) {
      return { text: '', toolCalls: [], rawParts: [] };
    }

    const toolCalls: ToolCall[] = (choice.tool_calls || []).map((tc) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      return {
        id: tc.id,
        name: tc.function.name,
        args: parsedArgs,
      };
    });

    return {
      text: choice.content || '',
      toolCalls,
      rawParts: toolCalls.map((tc) => ({
        thought_signature: 'skip_thought_signature_validator',
        functionCall: {
          name: tc.name,
          args: tc.args,
        },
      })),
    };
  }
}
