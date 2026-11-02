/**
 * 同义词表（查询扩展）—— 规格：docs/learning/05-rag-bm25.md §5.4。
 *
 * 组内任一词出现在查询中，把组内所有词并入查询（并集扩展）。
 * 查询扩展优于索引扩展（05 §6）：改查询即时生效、不动存储；
 * 代价是扩展词不进文档 → IDF 波动，影响可忽略。
 */

const SYNONYM_GROUPS: string[][] = [
  ["巨无霸", "big mac", "bigmac"],
  ["麦辣鸡腿堡", "麦辣堡"],
  ["可乐", "coke", "cola", "可口可乐"],
  ["薯条", "fries"],
  ["汉堡", "burger", "堡"],
  ["蛋挞", "egg tart"],
  ["鸡腿堡", "鸡腿汉堡"],
  ["麦当劳", "M记", "m记", "金拱门"],
  ["肯德基", "KFC", "kfc", "开封菜"],
  ["热量", "千卡", "大卡", "kcal", "卡路里"],
];

/**
 * 查询扩展：命中组内任一词则并入全组。
 * 幂等性保证：组内**全部**词都已存在时跳过该组——扩展结果再扩展不再增长
 * （learning/05 §5.4 规格要求，v0.6.0 评测发现初版不幂等后修正）。
 */
export function expandQuery(query: string): string {
  let q = query.toLowerCase();
  for (const group of SYNONYM_GROUPS) {
    // q 已小写化，组内词必须同样小写后再比对（"KFC" 原样比对永远 miss → 该组
    // 永不跳过 → 幂等破坏。v0.6.0 评测抓到的第二个真问题）
    const lowered = group.map(w => w.toLowerCase());
    if (lowered.every(w => q.includes(w))) continue; // 已扩展过（幂等）
    if (lowered.some(w => q.includes(w))) q += " " + lowered.join(" ");
  }
  return q;
}
