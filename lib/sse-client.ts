/**
 * 前端 SSE 解析器（服务端协议见 lib/ai/sse.ts）
 *
 * 为什么单独抽出来：原来三个调用点都直接 `chunk.split('\n')`，
 * 一条 `data:` 行被网络切成两段时会 JSON.parse 失败并被静默丢弃，
 * 表现为"回答里偶尔少几个字"。这里按行缓冲，只有完整行才解析。
 */

export async function consumeSse(
  res: Response,
  onDelta: (text: string) => void,
): Promise<void> {
  if (!res.body) throw new Error('无响应流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.replace(/\r$/, '');
    if (!line.startsWith('data:')) return false;

    const payload = line.slice(5).trim();
    if (!payload) return false;
    if (payload === '[DONE]') return true;

    try {
      const json = JSON.parse(payload) as { delta?: { text?: string } };
      const text = json.delta?.text;
      if (text) onDelta(text);
    } catch {
      // 半包或非 JSON 行，忽略
    }
    return false;
  };

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (handleLine(line)) {
          finished = true;
          break;
        }
        newlineIndex = buffer.indexOf('\n');
      }
    }

    if (!finished) {
      buffer += decoder.decode();
      for (const line of buffer.split('\n')) {
        if (handleLine(line)) break;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** 非 2xx 时取出服务端给的错误文案（AI 未配置、限流等） */
export async function readErrorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string; hint?: string };
    if (json?.error) return json.hint ? `${json.error}（${json.hint}）` : json.error;
  } catch {
    // 不是 JSON 就走下面的兜底
  }
  return `请求失败（HTTP ${res.status}）`;
}
