## 安装

```bash
docker build -t cpi:6.8.39 .
```

## 启动

```bash
docker run -d --name cpi -p 8317:8317 -p 5371:5371 cpi:6.8.39
```

## 清理
```bash
# 浏览器控制台（优先，不需要手动传 token，使用当前登录态）
# 打开 http://localhost:8317 后，F12 -> Console 粘贴执行 clean-script.browser.js 内容

# PowerShell（需要 Authorization）
powershell -NoProfile -ExecutionPolicy Bypass -File .\clean-script.ps1 -Authorization 'wp1N$ARPhNhN+Xy5t6' -ScanConcurrency 12 -ShowPerFileResult

# 真正执行删除（去掉 -DryRun）
powershell -NoProfile -ExecutionPolicy Bypass -File .\clean-script.ps1 -Authorization 'wp1N$ARPhNhN+Xy5t6' -ScanConcurrency 12
```
