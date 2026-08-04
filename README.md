# CJHX Agile Workflow

CJHX Agile Workflow 是一个开放、可插拔、可治理的 **Skill-Driven Agentic SDLC** 框架。它以 Jira、Confluence、可配置代码托管平台和博云 DevOps 为研发主干，通过 Agent、Skills、适配器、质量证据和人工门禁贯通：

```text
意图表达 → 需求理解 → 用例与技术设计 → 代码实现 → 代码审查
→ 质量验证 → 交付验收 → 变更质检与部署 → 持续迭代
```

当前仓库提供一个可运行的 MVP 控制面和扩展 SDK，不替代现有研发平台。

## 已实现

- 有证据门禁的研发变更生命周期状态机；
- 统一 Change、Evidence、Skill、SkillRun 和 WorkflowRun 模型；
- Skill 本地注册、安装、版本锁定和 SHA-256 防篡改；
- 内置 Skill 与受控外部进程 Skill；
- Skill 风险等级、来源白名单、写操作审批和超时策略；
- 声明式多 Skill Workflow 和跨步骤 `$ref` 数据传递；
- Jira、Confluence、代码托管平台、博云 DevOps 和未来运行观测的适配器契约；
- 权限检查后的 ToolBroker，Skill 不直接获得平台凭据；
- 需求拆解、测试用例生成、代码评审、API 测试执行、Jira→Confluence 同步示例；
- CLI、JSON 文件状态存储和执行审计记录。

## 工具职责

| 工具 | 权威职责 |
|---|---|
| Jira | 工作项、状态、Owner、迭代、风险和审批 |
| Confluence | 需求、用例、技术方案、ADR、测试策略和复盘 |
| 代码托管平台 | 仓库、分支、提交、代码变更请求和代码评审 |
| 博云 DevOps | 构建、扫描、测试、质量门禁、制品、部署和回滚 |
| CJHX | 生命周期编排、Skill 运行、权限策略、证据索引和审计 |
| 运行观测平台 | 暂不建设，通过 `ObservabilityAdapter` 预留 |

框架核心不绑定任何具体代码托管产品。

## 快速开始

要求 Python 3.11+，运行时无第三方依赖。

```bash
cd cjhx-agile-workflow
python3 -m venv .venv
. .venv/bin/activate
pip install -e .

cjhx init
cjhx change-create PAY-128 "批量取消订单" --owner product-owner

cjhx skill-install examples/skills/requirement-decompose
cjhx skill-install examples/skills/test-case-generate

cjhx skill-run requirement.decompose \
  --change-id PAY-128 \
  --input '{"requirement":"支持批量取消订单；记录操作审计日志"}'

cjhx workflow-run examples/requirement-to-tests.workflow.json \
  --change-id PAY-128 \
  --input '{
    "requirement":"支持批量取消订单；记录操作审计日志",
    "feature":"批量取消订单",
    "acceptanceCriteria":["返回每个订单的处理结果"]
  }'
```

框架状态默认保存到 `.cjhx/`：

```text
.cjhx/
├── changes/            # 变更状态与证据索引
├── skills/             # 已安装的不可变 Skill 包
├── skills-lock.json    # 版本与摘要锁定
└── runs/               # Skill 和 Workflow 执行记录
```

业务事实仍保存在其权威平台中；`.cjhx` 不复制 Jira、Confluence 或博云的完整业务数据。

## 生命周期门禁示例

确认意图前需要 `intent-approval` 证据：

```bash
cjhx evidence-add PAY-128 intent-approval \
  --source jira --status approved --subject jira://PAY-128

cjhx change-transition PAY-128 intent_confirmed \
  --actor product-owner --reason "业务目标、范围和成功指标已确认"
```

后续门禁依次要求需求规格、设计及审批、代码变更请求、代码评审、质量验证、业务验收、发布计划及审批、部署记录和结果验证。

## 安装自有或外部 Skill

每个 Skill 是一个包含 `skill.json` 的版本化目录：

```text
my-skill/
├── skill.json
├── main.py             # 可选外部进程入口
├── schemas/            # 推荐：输入输出 Schema
├── tests/              # 推荐：行为测试
└── evaluations/        # 推荐：质量、安全和回归评测
```

```bash
cjhx skill-install ./my-skill
cjhx skill-list
cjhx skill-run my.skill --input @payload.json
```

CLI 的 `--input` 接受 JSON 字符串或文件路径。外部可执行 Skill 默认禁用；生产使用应在独立沙箱中执行，并经过来源、许可证、依赖、数据外发、权限和质量评测。

## 开发与测试

```bash
PYTHONPATH=src python3 -m unittest discover -s tests -v
PYTHONPATH=src python3 -m compileall -q src tests
```

## 文档

- [架构与边界](docs/ARCHITECTURE.md)
- [Skill 开发与治理](docs/SKILLS.md)
- [Jira、Confluence、代码托管、博云和观测适配](docs/INTEGRATIONS.md)

## MVP 边界

当前版本提供本地文件状态库、适配器契约和内存测试适配器。生产落地仍需根据企业部署版本实现：

1. Jira 和 Confluence API/Webhook Adapter；
2. 所选代码托管平台 Adapter；
3. 博云 DevOps API/Webhook Adapter；
4. 数据库、事件队列、身份与密钥服务；
5. 外部 Skill 的容器或微虚机沙箱；
6. 企业 Skill Registry、签名、评测和灰度发布；
7. 后续运行观测 Adapter。

## License

Apache License 2.0。
