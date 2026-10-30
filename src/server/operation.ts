/** 同一路径连续失败三次后停止调用；重启服务或明确重置后才能重新核验。 */
export class OperationGate {
  private authenticationFailed = new Set<string>();
  private failures = new Map<string, number>();
  stopped(path: string) { return (this.failures.get(path) ?? 0) >= 3; }
  stoppedReason(path: string) { return this.authenticationFailed.has(path) ? '该路径鉴权失败，已停止后续调用；请核对凭据和接口契约后重启服务' : '同一外部调用路径连续失败三次，已停止剩余分析；请核对契约后重启服务'; }
  async run<T>(path: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped(path)) throw new Error(this.stoppedReason(path));
    try { const value = await operation(); this.failures.delete(path); return value; }
    catch (error) {
      // 鉴权失败先核对契约，不用剩余候选重复验证同一凭据。
      if (error instanceof Error && /HTTP (401|403)\b/.test(error.message)) { this.authenticationFailed.add(path); this.failures.set(path, 3); }
      else this.failures.set(path, (this.failures.get(path) ?? 0) + 1);
      throw error;
    }
  }
}
