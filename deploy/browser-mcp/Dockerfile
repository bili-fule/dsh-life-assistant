ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HOME=/tmp NODE_OPTIONS=--max-old-space-size=96
WORKDIR /browser
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org
USER 65534:65534
ENTRYPOINT ["node","/browser/node_modules/@playwright/mcp/cli.js"]
CMD ["--browser","chromium","--headless","--isolated","--no-sandbox","--executable-path","/chromium","--output-dir","/tmp/output","--output-max-size","16777216"]
