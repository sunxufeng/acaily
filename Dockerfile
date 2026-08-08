# Acaily 镜像（T6.3 上线切换）
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
# 本工程零运行时依赖；保留 npm install 占位以兼容后续依赖
RUN npm install --omit=dev || true
COPY . .
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["npm", "start"]
