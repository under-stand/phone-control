const state = document.querySelector("#state");
const detail = document.querySelector("#detail");
const status = document.querySelector(".status");
const service = document.querySelector("#service");
const reconnect = document.querySelector("#reconnect");

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "status" });
  const online = Boolean(result?.connection?.connected);
  status.classList.toggle("online", online);
  state.textContent = online ? "已连接 Phone Control" : "尚未连接";
  detail.textContent = online
    ? "现在可以在手机里的 Phone Control 选择并操作已经打开的普通网页。"
    : result?.connection?.error || "请确认 Phone Control 服务正在运行。";
  service.textContent = result?.serviceUrl || "http://127.0.0.1:8787";
}

reconnect.addEventListener("click", async () => {
  reconnect.disabled = true;
  reconnect.textContent = "连接中…";
  await chrome.runtime.sendMessage({ type: "reconnect" });
  reconnect.disabled = false;
  reconnect.textContent = "重新连接";
  await refresh();
});

void refresh();
