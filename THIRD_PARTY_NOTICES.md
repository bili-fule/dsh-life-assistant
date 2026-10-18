# Third-party notices

`src/ilink.mjs` is adapted from the MIT-licensed iLink protocol client in
[tangwenhao616-netizen/dsh-clawbot](https://github.com/tangwenhao616-netizen/dsh-clawbot),
commit `77748ea665e215aab9f9e7f9890802441af5b92e` (retrieved 2026-10-18).
Original copyright: 2026 dsh-weixin contributors.
Its MIT license is preserved in `licenses/dsh-clawbot-MIT.txt`.
Changes add stable outgoing message identifiers and check the alternative
`errcode` response field. The assistant does not use the upstream agent control,
shell execution, session manager, or web panel.

The wire protocol is documented by [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md).

`qrcode-generator` is a separate MIT-licensed dependency, installed through npm.
DeepSeek Harness and its official SDK packages remain separate dependencies;
no DeepSeek Harness source is modified or redistributed in this repository.
