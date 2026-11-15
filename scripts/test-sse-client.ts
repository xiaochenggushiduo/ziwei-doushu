/**
 * lib/sse-client.ts 的回归测试：把服务端 SSE 切成任意碎片，验证前端能完整还原文本。
 * 运行：npx tsx scripts/test-sse-client.ts
 */
import { consumeSse, readErrorMessage } from '../lib/sse-client';

function makeResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

const events = [
  { delta: { text: '紫微' } },
  { delta: { text: '在' } },
  { delta: { text: '子宫' } },
  { delta: { text: '，庙旺。' } },
];
const full = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';

async function main() {
// 1) 正常整包
{
  let text = '';
  await consumeSse(makeResponse([full]), t => { text += t; });
  console.log(text === '紫微在子宫，庙旺。' ? 'PASS 整包' : `FAIL 整包: ${text}`);
}

// 2) 逐字节切碎（模拟最恶劣的网络分包）
{
  let text = '';
  await consumeSse(makeResponse(full.split('')), t => { text += t; });
  console.log(text === '紫微在子宫，庙旺。' ? 'PASS 逐字节' : `FAIL 逐字节: ${text}`);
}

// 3) 在 JSON 中间断开
{
  const cut = full.indexOf('"text":"在"') + 4;
  let text = '';
  await consumeSse(makeResponse([full.slice(0, cut), full.slice(cut)]), t => { text += t; });
  console.log(text === '紫微在子宫，庙旺。' ? 'PASS 中间断开' : `FAIL 中间断开: ${text}`);
}

// 4) CRLF 换行
{
  let text = '';
  await consumeSse(makeResponse([full.replace(/\n/g, '\r\n')]), t => { text += t; });
  console.log(text === '紫微在子宫，庙旺。' ? 'PASS CRLF' : `FAIL CRLF: ${text}`);
}

// 5) 服务端错误响应体
{
  const msg = await readErrorMessage(Response.json({ error: 'AI 未配置', hint: '设置 DEEPSEEK_API_KEY' }, { status: 503 }));
  console.log(msg === 'AI 未配置（设置 DEEPSEEK_API_KEY）' ? 'PASS 错误文案' : `FAIL 错误文案: ${msg}`);
}
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
