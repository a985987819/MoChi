/** 气泡只展示文字、不参与输入命中；完整文本仍留在可访问树，视觉正文限制三行。 */
export function PetBubble({ text, leaving }: { text: string; leaving: boolean }) {
  return (
    <aside className={`pet-bubble${leaving ? " pet-bubble--leaving" : ""}`}
      role="status" aria-live="polite" aria-atomic="true" title={text}>
      <span className="pet-bubble__text">{text}</span>
    </aside>
  );
}
