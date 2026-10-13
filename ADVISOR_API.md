# 智能部署顾问：云端接口设计

## 目标

客户用自然语言描述业务场景，顾问负责提取条件、追问缺项、解释候选方案；卡数、功耗、成本和临界点始终由确定性的计算引擎生成。

```text
浏览器 UI
  → 你的云端服务器 /api/advisor/analyze
  → 大模型理解与生成
  → 结构化 JSON + 数据引用 + 参数补丁
  → 用户确认
  → 浏览器校验并应用补丁
  → CostEngine 重新计算
```

API Key 只保存在服务器环境变量中，绝不写入 HTML、浏览器缓存或分享链接。

## POST `/api/advisor/analyze`

请求：

```json
{
  "conversation_id": "optional-uuid",
  "scenario_text": "80名研发，20路并发，每天12小时，数据不能出域，预算300万元，希望国产化。",
  "messages": [],
  "current_state": {
    "model_id": "qwen235",
    "card_id": "h20",
    "cloud_mode": "continuous"
  },
  "catalog_version": "2026-08-11"
}
```

响应：

```json
{
  "conversation_id": "uuid",
  "status": "needs_confirmation",
  "assistant_message": "我识别到以下场景，请先确认。",
  "extracted_scenario": {
    "users": 80,
    "peak_concurrency": 20,
    "active_hours": 12,
    "workload_type": ["coding", "agent"],
    "data_residency": "on_prem_only",
    "budget_wan": 300,
    "domestic_preference": true,
    "context_k": null,
    "input_tokens": null,
    "output_tokens": null,
    "provided_fields": ["users", "concurrency", "activeHours", "task", "sensitive", "budgetWan", "domestic"]
  },
  "missing_questions": [
    "平均输入和输出分别约多少 Token？",
    "是否接受 FP8 或 INT4 量化？"
  ],
  "recommendations": [
    {
      "id": "local-primary",
      "title": "本地优先",
      "model_id": "qwennext",
      "card_id": "a910c",
      "reason": "满足数据不出域与国产化偏好。",
      "citations": [
        {"catalog": "models", "id": "qwennext", "confidence": "B"},
        {"catalog": "cards", "id": "a910c", "confidence": "C"}
      ]
    }
  ],
  "proposed_patch": {
    "codeUsers": 80,
    "codeActivePct": 16.7,
    "modelSelect": "qwennext",
    "cardSelect": "a910c",
    "cloudMode": "continuous"
  },
  "warnings": [
    "吞吐档案为 C 级工程估算，采购前必须压测。"
  ]
}
```

## 约束

- 模型与卡只能引用当前目录中存在的 `id`，不得自由编造型号。
- `proposed_patch` 使用白名单字段；浏览器再次校验范围后才能展示“应用到测算”。
- 大模型不得直接输出卡数、TCO 或临界天数作为最终答案；这些值由 `CostEngine` 基于确认后的补丁重算。
- 每项推荐必须带数据引用和可信度；C 级数据自动附加压测提示。
- 未确认前不改变任何测算字段；应用前保存完整快照，可一键撤销。
- 默认只集中追问一轮，每轮最多 3 个高影响问题；普通缺项随后由前端场景模板补齐。只有信息互相矛盾时才允许第二轮追问。
- 所有补齐值必须出现在“本次测算采用的条件”中，并标明“客户提供 / 系统假设 / 系统推导 / 待压测”，客户可修改后再应用。
- “上下文 128K”只表示模型能力上限，不自动写成 Prefill 128K；只有客户明确说“输入 128K”时才写入 input_tokens=128000。
- 直接给出“20 路并发”时，不自动反推为“100 人、20% 活跃率”；总用户未知时先使用可见假设。
- 昇腾 910C 的候选精度不包含 FP8；模型目录标注 INT8 适配时优先 W8A8，否则回退 BF16。KV Cache 精度独立选择。

## 安全与运维

- 服务端鉴权、限流和审计；默认不长期保存客户原始场景。
- 日志先脱敏，避免记录姓名、客户名、项目代号和业务数据样本。
- 模型调用设置超时与重试；失败时返回明确恢复动作，不返回技术堆栈。
- 建议支持 SSE 流式响应，但结构化 JSON 必须在结束事件中一次性校验。
- 目录版本随请求传入；服务器发现版本不一致时返回 `catalog_version_mismatch`，禁止用旧数据静默推荐。

## 推荐部署边界

第一阶段只实现场景提取、缺项追问和参数补丁；第二阶段再加入多轮方案比较、压测数据检索和报价单读取。这样可以先保证“理解正确、计算可复现、应用可撤销”。
