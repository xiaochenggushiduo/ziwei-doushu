/**
 * 把文本增量流包装成前端约定的 SSE 格式：
 *   data: {"delta":{"text":"..."}}\n\n
 *   ...
 *   data: [DONE]\n\n
 *
 * 前端三个调用点（ChatPanel / InsightPanel / heming）都按这个格式解析，
 * 换协议时只需要改这里。
 */
export function createSseResponse(source: AsyncGenerator<string>, request: Request): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();

  // 浏览器关闭页面 / 组件卸载时，及时掐掉上游请求，避免继续烧 token
  const onAbort = () => abort.abort();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener('abort', onAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      try {
        for await (const text of source) {
          if (abort.signal.aborted) break;
          if (text) send({ delta: { text } });
        }
        if (!abort.signal.aborted) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      } catch (error) {
        const cancelled = abort.signal.aborted || request.signal.aborted;
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[ai] stream failed:', message || '(空消息)');
          send({ delta: { text: '\n\n（生成中断，请重试；若反复出现请检查服务端日志与 API 余额。）' } });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        try {
          controller.close();
        } catch {
          // 已关闭则忽略
        }
      }
    },
    cancel() {
      onAbort();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉反向代理缓冲，否则流式会被攒成一坨
      'X-Accel-Buffering': 'no',
    },
  });
}

/** 统一的错误响应（前端会读 error 字段直接展示） */
export function jsonError(status: number, error: string, hint?: string): Response {
  return Response.json({ error, hint }, { status });
}
