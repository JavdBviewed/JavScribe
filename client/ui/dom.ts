// UI 层小工具：DOM 取用 + HTML 转义（web / desktop 共享）

export const $ = (id: string): HTMLElement => document.getElementById(id)!;

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c
  ));
}
