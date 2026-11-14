export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface Finding {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  title: string;
  explanation: string;
  suggestedFix: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, {
      type: string;
      description?: string;
      items?: { type: string };
    }>;
    required?: string[];
  };
}

export interface GeminiPart {
  text?: string;
  thought_signature?: string;
  thoughtSignature?: string;
  thought?: boolean;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: GeminiPart[];
    };
    finishReason?: string;
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

export interface ExtensionConfig {
  geminiApiKey: string;
  model: string;
  baseUrl: string;
  maxTurns: number;
}
