/** 称呼是应用偏好，UI 和提示词共用默认值，避免老配置与聊天行为不同步。 */
export interface AddressingPreferences {
  petSelfName: string;
  userNickname: string;
}

export const DEFAULT_ADDRESSING: Readonly<AddressingPreferences> = {
  petSelfName: "麻薯",
  userNickname: "人",
};

/** 兼容缺失/损坏的旧配置，空白回落默认值；只持有称呼文本，不接受指令结构。 */
export function normalizeAddressing(raw: Partial<AddressingPreferences> = {}): AddressingPreferences {
  const name = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  return {
    petSelfName: name(raw.petSelfName, DEFAULT_ADDRESSING.petSelfName),
    userNickname: name(raw.userNickname, DEFAULT_ADDRESSING.userNickname),
  };
}
