# Third-party notices

`src/ilink.mjs` is adapted from the MIT-licensed iLink protocol client in
[tangwenhao616-netizen/dsh-clawbot](https://github.com/tangwenhao616-netizen/dsh-clawbot),
commit `77748ea665e215aab9f9e7f9890802441af5b92e` (retrieved 2026-10-18).
Original copyright: 2026 dsh-weixin contributors.
Its MIT license is preserved in `licenses/dsh-clawbot-MIT.txt`.
Changes add stable outgoing message identifiers, check the alternative
`errcode` response field, and implement generated-file upload/send using the documented protocol. The assistant does not use the upstream agent control,
shell execution, session manager, or web panel.

The wire protocol is documented by [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md).

`qrcode-generator` is a separate MIT-licensed dependency, installed through npm.
DeepSeek Harness and its official SDK packages remain separate dependencies.
`deploy/native-request-view.patch` contains an optional source extension against
DeepSeek Harness 0.2.0-rc.2 (commit pinned in its adjacent JSON manifest),
Copyright (c) 2026 DeepSeek, MIT. Its license is preserved in
`licenses/dsh-MIT.txt`; the build script includes that license with each patched
runtime package. The patch extends native Session projections and Token Meter,
and retains the native Agent execution loop.

SnowLuma remains a separate, independently installed QQ gateway. This plugin
implements its OneBot 11 HTTP boundary independently and does not bundle or copy
SnowLuma implementation code, native binaries, QQ binaries or login data.

`fast-xml-parser` and `playwright-core` are separate MIT/Apache-2.0 dependencies installed through npm. Chromium, Poppler and antiword remain separate server dependencies; their binaries are not included in this repository.


## Optional isolated browser deployment

The deployment uses DeepSeek Harness browser-use and experimental browser-use runtime 0.2.0-rc.2 (MIT, upstream https://github.com/deepseek-ai/deepseek-harness), and Microsoft Playwright MCP 0.0.80 / Playwright 1.63.0-alpha-2026-08-31 (Apache-2.0, upstream https://github.com/microsoft/playwright-mcp). Browser operation code is obtained through its pinned npm lockfile during deployment, not copied into this plugin. Container/base images are not distributed by this repository; their licenses and build requirements remain applicable. See docs/browser.md for the distinction between the official integration and the local launch adapter.
