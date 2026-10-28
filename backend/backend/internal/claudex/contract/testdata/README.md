# Claudex 接口契约 fixture

客户端（C1，`tests/claudex-contract.test.ts`）与服务端联调（I1）共用的 JSON 样例。内容取自
`FINAL-claudex-backend-design.md` 第 2 节的示例，`…` 占位已填成合法值；B 包实际实现与设计不同的地方以实现为准
（例如信封错误的 `metadata` 值是字符串：`{"limit":"5","active":"5"}`）。

命名：`<接口>.<情形>.json`。

- 成功应答：完整信封 `{"code":0,"message":"success","data":…}`。
- 错误应答（`*-error.json`、`refusal.*.json`）：`{"status":<HTTP>,"headers":{…}?,"body":<完整错误体>}`。
- 请求体（`*.request.json`、`*-request.json`）：客户端发出的 JSON，客户端测试断言序列化结果与之一致。
- `section.*.json`：bootstrap 的单个区块，外层是区块名（`{"voice":…}`），测试时并入一个最小 bootstrap。
- `setting.*.json`、`admin-*.json`：设置键与管理接口样例，桌面端不读取，只校验是合法 JSON，供 I1 使用。

新增 fixture 时在 `tests/claudex-contract.test.ts` 的分类表里登记（未登记的文件会让测试失败）。
