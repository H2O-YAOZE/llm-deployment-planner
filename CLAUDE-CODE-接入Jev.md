# Claude Code 交接：保留内置问答窗口，接通 Jev

2026-10-04。本文描述当前交付代码；与旧方案冲突时，以本文、`ADVISOR-FLOW-20261003.md` 和实际代码为准。`docs/jev/SKILL-original.md` 是用户提供的原始参考资料，不是另一次修改界面的指令。

## 用户要什么

保留现有内置问答窗口和输入框，直接接好 Jev 的服务端密钥。不要另加独立 Jev 面板、复杂配置表或业务调查问卷。

Jev 前置判断客户模糊表述对应哪个指标；DeepSeek 整理具体数值和缺项；程序计算设备与费用。主要收集模型、精度、芯片/国产化、并发、输入、输出、单路 Token/s 和首Token迟延。每轮缺少的条件一次问全，不逐项反复追问业务。客户发出消息后输入框清空；失败或取消恢复输入。

两种推演必须分开：按需求找硬件；用已有硬件求某一个最大能力。后者不得再索要待求解的指标，不向反向工作台塞入 API 采购比较。

## 已有实现，不必重新搭一套

| 文件 | 负责什么 |
| --- | --- |
| `index.html`、`advisor-chat.js`、`advisor-chat.css` | 现有单聊天窗口；每轮先请求 interpret，再请求 analyze |
| `server.py` | 同源问答接口与静态文件白名单，保留现有鉴权 |
| `jev_intake.py` | 固定 Choice 判断：方向、人数/并发、延迟/速度、吞吐、上下文、输入、输出、模型/精度 |
| `jev_service.py` | TypeSafe 固定地址、版本、Bearer 认证与类型校验；不生成数字报价 |
| `private_config.py` | 只解析允许的配置项；环境变量优先于 `.env.local`，包括空值 |
| `advisor_service.py`、`advisor_flow.py`、`advisor-fields.json` | DeepSeek 整理与统一缺项清单，不追加业务复核 |
| `advisor-core.js`、`engine-v5.js`、`solver-v5.js`、`pricing.js` | 条件核验、正反向求解、费用计算 |
| `catalog.json`、`data.js` | 当前统一目录及前端派生数据；不要新建相互矛盾的模型/GPU价格表 |

当前浏览器流程：客户原话 → `POST /api/advisor/interpret` → 把合格 interpretation 带给 `POST /api/advisor/analyze` → 程序汇总缺项 → 客户确认 → 确定性引擎计算。不要恢复早期“Jev 只问一个问题就截断整轮整理”的流程。Jev 失败应明确降级，保留 DeepSeek 问答。

旧 `advisor-jev.js/css` 和独立 review 接口保留在包中，但不能据此再把旧业务复核面板放到客户首页。聊天的现有入口已接 interpret，无需把 Jev 改成聊天生成模型。

## 配置密钥

真实密钥另行交给用户，不在此包中。用户提供的 DeepSeek key 和 TypeSafe/Jev key 是不同凭证，不可互换。

在**实际运行的 server.py 所在目录**编辑 `.env.local`，只增加或更新以下项目，保留其他原有配置：

```dotenv
TYPESAFE_API_KEY=在此填写用户单独提供的TypeSafe密钥
TYPESAFE_MODEL=jev-1.13.0
JEV_ENABLED=true
JEV_AUTO_REVIEW=false
JEV_TIMEOUT_SECONDS=8
```

不得直接用示例文件覆盖现有 `.env.local`。`JEV_API_KEY` 是兼容旧名称；新配置用 `TYPESAFE_API_KEY`。文件逐请求读取，不需为文件内修改重启服务；如果运行进程已设置同名环境变量，应先查清来源，更新后再重启对应服务，否则文件值不会生效。

服务端使用 `POST https://api.typesafe.ai/v1/systemone`，发送 `model`、`state`、`questions`，不是 OpenAI messages 协议。固定版本应与返回版本一致。前置分类最多等待 5 秒，不自动重试付费调用。升级版本前查看当前官方文档并验证；包内文档快照仅代表 2026-10-01 查阅结果，不承诺永久有效。

## 本机和阿里云现状

- 本机安装目录：`D:\deployment-cost-panel-redesign`，端口 8095。2026-10-04 检查发现本机 Jev 和 DeepSeek 均已配置；不得把密钥值输出到日志。
- 云端地址：https://capacity.123.57.85.247.nip.io/ 。手机兼容代码已发布，DeepSeek 已配置，Jev 尚未配置。
- 云端运行目录 `/root/cost-panel`，后端环回端口 8090；PM2 `cost-panel`，部署核验时 id=4。操作前重新确认服务名、cwd 和端口，不能仅凭旧 id 重启。
- Caddy 转到 8094 的项目访问网关，再连接后端。不要改其他项目、网关、登录配置或原 `start.sh`。
- 代码交付不自动同步本机密钥。把单独密钥配置到云端属于后续操作，应由用户授权的 Claude Code 完成；本次交付没有执行这一步。

## 不可改坏的计算与页面条件

- 五变量页固定 DeepSeek V4 Flash / FP8 / H200；共同基准：20并发、输入80K、输出1K、单路30 Token/s、首Token≤30秒。
- 五行彼此独立，每行只改自己的指标，其他指标保持共同基准。共用推演引擎，不写死单台容量或人为制造价格上涨。
- 首Token滑块由左至右：200、60、30、20、15、10、5、1秒。移动时传实际秒数，其他滑块持续实时计算。
- 显存先展示权重，再单路KV，再总KV，最后硬件需要多少张/台；说明为什么选择每实例卡数和实例数。物理服务器数量、模型实例数量必须区分。
- 费用按整机采购有台阶，指标改变但尚未越过整机边界时，报价可能不变；不得因此硬加设备。
- 所有性能与设备数仍是规划估算，已有公开压测只校准匹配组合，外推不得包装为实机保证。详见 `SERVING-EVIDENCE-20261004.md`。
- API预算保持每天12小时、每月30天持续满载及填写的输入输出长度，不改成低利用率账单。
- 保留 `responsive.css` 和现有手机布局；320/390/768/1440宽度四个页面无横向溢出，聊天仅一个窗口和输入框。

## 接通后的验收

1. 在服务目录运行 `python -m unittest test_jev_service test_private_config test_jev_intake test_advisor_service test_advisor_flow -v`。这些是模拟上游的回归，不代表真实密钥已成功。
2. 在同源且已登录环境请求 `GET /api/advisor/status`，检查 `jev.configured`、`jev.ready`、`jev.model`。状态为 ready 仅表示配置存在，仍须真实请求确认。
3. 用合成文本请求 interpret（不发送客户隐私）：“公司有100人，想让回答快点，资料库很大”。确认能区分总人数与同时并发、开始回答与生成速度、资料总量与每次输入；不臆造任何数值。
4. 用聊天一次补齐模型、FP8、H200、20并发、输入80K、输出1K、30 Token/s、首Token30秒；确认不会问业务、已知项不再重复问，最终卡数/费用由引擎计算。
5. 反向测试已有1台8卡H200求最大并发，确认不再问“要求多少并发”；Jev故障、取消、输入恢复、密钥不进入页面/日志一起检查。
6. 云端操作只更新本项目：先备份变更文件与私有配置，再配置 Jev 并真实验收；任何重启只针对已确认的 cost-panel。报告要分别说明“配置存在、真实请求成功、页面成功、云端成功”，不能合并为一个“已接通”。

## 原始参考文档

`docs/jev/SKILL-original.md` 完整复制自 `C:\Users\14555\Desktop\桌面文件\SKILL (1).md`。`docs/jev/official-20261001/` 为旧官方接口快照。`JEV-ADVISOR-PLAN-20261001.md`、`JEV-SETUP-20261002.md`、`JEV-INTAKE-20261003.md` 保留历史方案；其中业务复核和旧页面描述已被当前需求替代，不要照搬旧界面。
