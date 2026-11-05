import { expect, it } from "vitest";
import { clampMenuPosition } from "../menu-position";

it("靠右下角打开菜单时按真实尺寸移回窗口内", () => {
  expect(clampMenuPosition(210, 250, 150, 150, 220, 260)).toEqual({ left: 66, top: 106 });
});
it("展开演示后根据新高度重新夹紧", () => {
  expect(clampMenuPosition(30, 160, 150, 252, 220, 260)).toEqual({ left: 30, top: 4 });
});
