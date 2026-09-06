// toast（web / desktop 共享；行为与迁移前 1:1）
import { $, esc } from "./dom";

export function toast(msg: string, kind: "ok" | "err" | "" = "") {
  const box = document.createElement("div");
  box.className = "toast" + (kind ? " " + kind : "");
  const icon = kind === "ok" ? "&#10003;" : kind === "err" ? "&#10007;" : "&#9679;";
  box.innerHTML = `<span class="t-icon">${icon}</span><span>${esc(msg)}</span>`;
  $("toasts").appendChild(box);
  setTimeout(() => box.remove(), 8000);
}
