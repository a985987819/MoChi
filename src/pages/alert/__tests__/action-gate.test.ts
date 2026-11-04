import { expect, it } from "vitest";
import { AlertActionGate } from "../action-gate";

it("同一 render 的两个确认同步互斥，不能等待 React pending 更新", () => {
  const gate = new AlertActionGate(() => 1000);
  expect(gate.tryBegin()).toBe(true);
  expect(gate.tryBegin()).toBe(false);
});

it("A 快速确认后切到 B，双击后半次和冷却期内新 click 都不会关闭 B", () => {
  let now = 0;
  const gate = new AlertActionGate(() => now);
  expect(gate.tryBegin({ clickCount: 1 })).toBe(true);
  gate.finish(); // 原生迅速显示 B，不重建手势门
  now = 100;
  expect(gate.tryBegin({ clickCount: 2 })).toBe(false);
  expect(gate.tryBegin({ clickCount: 1 })).toBe(false);
  now = 501;
  expect(gate.tryBegin({ clickCount: 1 })).toBe(true);
});

it("Enter/Space 长按跨越冷却时间也不能持续清空队列", () => {
  let now = 0;
  const gate = new AlertActionGate(() => now);
  expect(gate.tryBegin({ repeat: false })).toBe(true);
  gate.finish();
  now = 1000;
  expect(gate.tryBegin({ repeat: true })).toBe(false);
  expect(gate.tryBegin({ repeat: false })).toBe(true);
});

it("命令执行超过冷却时间仍保持锁，失败释放后可重试", () => {
  let now = 0;
  const gate = new AlertActionGate(() => now);
  expect(gate.tryBegin()).toBe(true);
  now = 2000;
  expect(gate.tryBegin()).toBe(false);
  gate.finish();
  expect(gate.tryBegin()).toBe(true);
});
