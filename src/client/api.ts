import type { ErrorResponse } from '../shared/contracts';

/** 请求本地服务；保留后端业务错误，响应格式错误不得伪装成空数据。 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`服务返回了无法读取的响应（HTTP ${response.status}），请检查本地服务。`);
  }
  if (!response.ok) {
    const error = body as Partial<ErrorResponse> | null;
    throw new Error(typeof error?.error === 'string' ? error.error : `请求失败（HTTP ${response.status}）`);
  }
  return body as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求未完成，请重试。';
}

/** 外部材料只能跳转到 HTTP(S) 页面，不执行材料中夹带的 URL 协议。 */
export function externalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
