/**
 * 秘密情報 (userId, password, raw secrets) のサニタイズモジュール
 */

const SECRET_KEYS = new Set([
  'userid',
  'user_id',
  'password',
  'pass',
  'secret',
  'token',
  'authorization',
  'cookie'
]);

/**
 * 任意のオブジェクト/配列から機微情報を再帰的に除去・マスクする
 */
export function sanitizeObject<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return obj as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj as Record<string, any>)) {
      const lower = k.toLowerCase();
      if (SECRET_KEYS.has(lower)) {
        res[k] = '[REDACTED]';
      } else if (typeof v === 'object' && v !== null) {
        res[k] = sanitizeObject(v);
      } else {
        res[k] = v;
      }
    }
    return res as T;
  }

  return obj;
}

/**
 * 文字列中にパスワードやトークンが含まれていないかチェックしマスクする
 */
export function sanitizeString(text: string): string {
  return text.replace(/(password|pass|userId|user_id)[:=]\s*["']?[^"'\s,]+["']?/gi, '$1=[REDACTED]');
}
