const state = document.querySelector("#state");
const detail = document.querySelector("#detail");
const status = document.querySelector(".status");
const service = document.querySelector("#service");
const reconnect = document.querySelector("#reconnect");
const serviceUrlInput = document.querySelector("#service-url");
const saveServiceUrl = document.querySelector("#save-service-url");

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "status" });
  const online = Boolean(result?.connection?.connected);
  status.classList.toggle("online", online);
  state.textContent = online ? "已连接 Phone Control" : "尚未连接";
  detail.textContent = online
    ? "现在可以在手机里的 Phone Control 选择并操作已经打开的普通网页。"
    : result?.connection?.error || "请确认 Phone Control 服务正在运行。";
  serviceUrlInput.value = result?.serviceUrl || "";
  service.textContent = result?.serviceUrl || "自动发现 127.0.0.1:8787-8807";
}

reconnect.addEventListener("click", async () => {
  reconnect.disabled = true;
  reconnect.textContent = "连接中…";
  await chrome.runtime.sendMessage({ type: "reconnect" });
  reconnect.disabled = false;
  reconnect.textContent = "重新连接";
  await refresh();
});

saveServiceUrl.addEventListener("click", async () => {
  saveServiceUrl.disabled = true;
  const result = await chrome.runtime.sendMessage({
    type: "set-service-url",
    serviceUrl: serviceUrlInput.value,
  });
  saveServiceUrl.disabled = false;
  if (!result?.ok) {
    detail.textContent = result?.error || "服务地址无效";
    return;
  }
  await refresh();
});

void refresh();
