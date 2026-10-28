# 网页版协议样例（W-PROTO）

`shared/web-protocol.ts`（`tests/web-protocol.test.ts`）与 Go 镜像 `internal/claudex/webproto`
（`webproto_test.go`）共用的 JSON 样例。两边都逐个解析、再编码，结果必须与样例相同；
`invalid.json` 中的每一项两边都必须拒绝；`constants.json` 是两边常量（路径、头、限额、关闭码、错误码、
runner 请求 op）的唯一对照。

命名：

- `rpc.request.json`：`POST rpc/<method>` 的请求体；`rpc.response.*.json`：`{"status":<HTTP>,"body":<应答体>}`。
- `ticket.*.json`：事件 WebSocket 票据的申请、应答与 `Sec-WebSocket-Protocol` 解析用例。
- `events.browser.*` / `events.server.*`：浏览器 ⇄ Go 事件 WebSocket 帧。
- `link.runner.*` / `link.go.*`：claudex-runner ⇄ Go 的 runner link 帧。
- `doc.turn.*` / `doc.conversation.*`：webstore 存储文档（schema 1）；`doc.split.json` 是一段完整对话及其拆分结果。
- `bytes.json`：`{"$bytes": base64}` 编码用例。

新增样例时两边测试的前缀表都要登记（未登记的文件会让测试失败）。修改协议时两边代码与样例一起改。
