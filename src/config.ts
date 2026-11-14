import * as vscode from 'vscode';
import { ExtensionConfig } from './types';

export function getExtensionConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration('localRobin');
  
  return {
    geminiApiKey: config.get<string>('geminiApiKey', '').trim(),
    model: config.get<string>('model', 'gemini-2.5-flash').trim(),
    baseUrl: config.get<string>('baseUrl', 'https://generativelanguage.googleapis.com').trim().replace(/\/+$/, ''),
    maxTurns: config.get<number>('maxTurns', 5),
  };
}
