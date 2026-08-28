# Contributing

感谢你改进 Phone Control。项目优先保证任务状态可信、手机交互稳定，以及默认不扩大本机
Codex 的权限边界。

## 开始开发

需要 Node.js 22 或更高版本：

```bash
cd plugins/plugin-phone-control
npm ci
npm run verify
npx playwright install chromium
npm run test:mobile
```

`npm run verify` 必须保持通过。涉及页面布局、输入、连接、通知或任务详情的改动，还应运行
`npm run test:mobile`。若使用已有 Chromium，可设置 `PHONE_CONTROL_BROWSER`。

## 提交改动

- 先用 Issue 描述较大的行为变化；小型修复可直接提交 Pull Request。
- 一个 Pull Request 只解决一个清晰问题，并说明用户可见结果与验证方式。
- 新行为需要自动化测试；边界或权限变化同时更新 `SECURITY.md`。
- 不要提交真实 IP、主机名、用户名、工作目录、访问令牌、证书、会话记录或
  `~/.phone-control` 数据。
- 示例必须使用 RFC 5737 保留地址（如 `203.0.113.10`）和通用路径。

安全问题不要提交公开 Issue，请按 [SECURITY.md](SECURITY.md) 的私密报告方式处理。
