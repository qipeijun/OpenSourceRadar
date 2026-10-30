export type Fetch = typeof globalThis.fetch;

/** 网络错误只返回可诊断类别与状态，不将第三方响应中的密钥或请求内容传给浏览器。 */
export async function request(fetcher: Fetch, url: string, init: RequestInit = {}, timeout = 45_000): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    throw new Error(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? '外部服务请求超时' : '无法连接外部服务，请检查网络与服务地址');
  }
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    throw new Error(`外部服务返回 HTTP ${response.status}${remaining === '0' ? '（GitHub 请求额度已用尽）' : ''}`);
  }
  return response;
}

export async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('外部服务响应读取超时，未获得完整结果');
    throw new Error('外部服务未返回合法 JSON');
  }
}
