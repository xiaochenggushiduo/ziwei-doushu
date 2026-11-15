/**
 * 内联脚本组件。
 *
 * React 19 在开发模式下会对组件渲染出的可执行 <script> 报警告
 * （"Encountered a script tag while rendering React component..."）。
 * 这里按 Next.js 文档 preventing-flash-before-hydration 的做法：
 * - 服务端渲染为 text/javascript —— 浏览器解析 HTML 时同步执行，避免首屏闪烁；
 * - 客户端渲染为 text/plain —— React 将其视为数据块，不会警告也不会执行。
 * suppressHydrationWarning 用于忽略两端 type 属性的差异。
 */
export function InlineScript({ html }: { html: string }) {
  return (
    <script
      type={typeof window === 'undefined' ? 'text/javascript' : 'text/plain'}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
