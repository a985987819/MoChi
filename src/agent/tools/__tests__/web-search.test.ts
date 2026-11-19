import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainSnippet, webSearchTool } from "../web-search";
import type { ToolContext } from "../registry";

/**
 * 联网搜索工具（v0.29.4）：用假 fetch 固定"DeepSeek / 维基百科"两种协议形状，
 * 不依赖真实网络。重点验证：数据源优先级、结果映射、HTML 清洗、失败回退。
 */

const deps = vi.hoisted(() => ({ apiKeys: {} as Record<string, string> }));
vi.mock("@/services/settings", () => ({
  loadSettings: async () => ({ apiKeys: deps.apiKeys }),
}));

function response(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => payload } as Response;
}

function ctx(): ToolContext {
  return { signal: new AbortController().signal, services: {} as ToolContext["services"] };
}

beforeEach(() => {
  deps.apiKeys = {};
});

afterEach(() => vi.unstubAllGlobals());

describe("web_search", () => {
  it("配置 DeepSeek Key：优先调用 Search API，summary 映射为 snippet", async () => {
    deps.apiKeys.deepseek = "sk-test";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.deepseek.com/v1/tools/search");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      expect(JSON.parse(String(init?.body))).toMatchObject({ query: "麻薯", count: 2, need_content: false });
      return response({
        results: [
          { title: "麻薯", url: "https://example.com/mochi", summary: "长摘要内容", snippet: "短摘要" },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await webSearchTool().execute({ query: "麻薯", limit: 2 }, ctx());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { source: string; results: Array<{ snippet: string; url: string }> };
    expect(data.source).toBe("DeepSeek Search API");
    expect(data.results[0]).toMatchObject({ snippet: "长摘要内容", url: "https://example.com/mochi" });
  });

  it("DeepSeek 失败：自动回退维基百科", async () => {
    deps.apiKeys.deepseek = "sk-test";
    vi.stubGlobal("navigator", { language: "zh-CN" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) return response({}, false, 503);
      return response({ query: { search: [{ title: "麻薯", snippet: "点心" }] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await webSearchTool().execute({ query: "麻薯" }, ctx());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { source: string; results: unknown[] };
    expect(data.source).toBe("zh.wikipedia.org");
    expect(data.results).toHaveLength(1);
  });

  it("未配置 Key：直接走维基百科，并带 origin=*（CORS 必需）", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      response({
        query: {
          search: [
            { title: "麻薯", snippet: '<span class="searchmatch">麻薯</span>是一种&nbsp;点心 &amp; 甜食' },
            { title: "Mochi (food)", snippet: "Japanese rice cake" },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await webSearchTool().execute({ query: "麻薯", limit: 2 }, ctx());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { source: string; results: Array<{ title: string; snippet: string; url: string }> };
    expect(data.source).toBe("zh.wikipedia.org");
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toMatchObject({
      title: "麻薯",
      snippet: "麻薯是一种 点心 & 甜食",
      url: "https://zh.wikipedia.org/wiki/%E9%BA%BB%E8%96%AF",
    });
    // limit 原样传给 API，且带 origin=*（CORS 必需）
    const calledUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(calledUrl).toContain("srlimit=2");
    expect(calledUrl).toContain("origin=*");
  });

  it("两种语言都零结果：返回 ok + 明确提示，不伪造条目", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    const fetchMock = vi.fn(async () => response({ query: { search: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await webSearchTool().execute({ query: "不存在的条目 xyz", limit: 3 }, ctx());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { results: unknown[]; note: string };
    expect(data.results).toEqual([]);
    expect(data.note).toContain("没有找到");
    expect(fetchMock).toHaveBeenCalledTimes(2); // 主语言 + 兜底语言
  });

  it("网络失败：返回可解释的 note，而不是抛异常炸 Agent 循环", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    vi.stubGlobal("fetch", vi.fn(async () => response({}, false, 503)));

    const outcome = await webSearchTool().execute({ query: "麻薯" }, ctx());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const data = outcome.data as { results: unknown[]; note: string };
    expect(data.results).toEqual([]);
    expect(data.note).toContain("联网搜索失败");
    expect(data.note).toContain("503");
  });

  it("plainSnippet 清除标签与常见实体", () => {
    expect(plainSnippet('<b>A</b>&nbsp;B &quot;C&quot; &#039;D&#039; &amp; E')).toBe('A B "C" \'D\' & E');
  });
});
