FROM node:20-alpine

RUN apk add --no-cache bash

WORKDIR /app

# 复制后端目录
COPY CLIProxyAPI_6.8.39_linux_amd64 /app/cli-proxy-api

# 给真正的可执行文件权限
RUN chmod +x /app/cli-proxy-api/cli-proxy-api

# 复制前端
COPY Cli-Proxy-API-Management-Center /app/management

# 安装前端依赖（构建阶段）
WORKDIR /app/management
RUN npm install

# 回到app目录
WORKDIR /app

EXPOSE 8317
EXPOSE 5371

# 使用 bash 启动两个进程
CMD sh -c "\
  cd /app/cli-proxy-api && ./cli-proxy-api & \
  cd /app/management && npm run dev -- --host 0.0.0.0 --port 5371 \
"