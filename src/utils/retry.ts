export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  backoff?: number;
}

export async function withRetry<T>(
  action: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retries = options.retries ?? 3;
  let delayMs = options.delayMs ?? 1000;
  const backoff = options.backoff ?? 1.5;

  let lastError: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await action();
    } catch (error: any) {
      lastError = error;
      // 指示16: 明確な認証エラー・学校不一致等は一切リトライせず即時中断
      if (
        error?.status === 'LOGIN_FAILED' ||
        error?.status === 'AUTH_OUTCOME_UNKNOWN' ||
        error?.status === 'SCHOOL_MISMATCH' ||
        error?.status === 'CREDENTIAL_NOT_FOUND' ||
        error?.status === 'UNSAFE_CONFIGURATION'
      ) {
        throw error;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.round(delayMs * backoff);
      }
    }
  }
  throw lastError;
}
