/**
 * SSE 解析器 —— 规格：docs/learning/02-provider-abstraction.md §4.2。
 *
 * SSE 是行式协议：`data: <载荷>` 行 + 空行分隔；OpenAI 兼容 API 的流式载体。
 * 为什么不用浏览器 EventSource：它只支持 GET、不能带 Authorization 头、不能 POST
 * body——所以必须 fetch + 手动读流（02 §2.2）。
 *
 * 解析规则（02 §2.2 的四条）：
 * 1. 每个事件以 `data:` 开头，事件间空行分隔；
 * 2. 忽略注释行（`:` 开头）与 `event:`/`id:` 等字段（chat completions 不用）；
 * 3. `data: [DONE]` 是结束哨兵（生成器 return）；
 * 4. 兼容 CRLF；多字节字符可能被 TCP 分包切断——decode 必须 stream 模式。
 */

export async function* parseSSE(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data:")) continue; // 空行/注释/其他字段：跳过
        const payload = line.slice(5).trimStart();
        if (payload === "[DONE]") return; // 结束哨兵
        yield payload;
      }
    }
    // 循环结束：buf 中残留的不完整行按协议丢弃（服务端保证事件完整才 flush）
  } finally {
    reader.releaseLock();
  }
}
