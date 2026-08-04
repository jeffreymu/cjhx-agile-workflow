# CJHX Agile Workflow

CJHX Agile Workflow 是一个开放、可插拔、可治理的 **Skill-Driven Agentic SDLC** 框架。它以 Jira、Confluence、可配置代码托管平台和博云 DevOps 为研发主干，通过 Agent、Skills、适配器、质量证据和人工门禁贯通：

```text
意图表达 → 需求理解 → 用例与技术设计 → 代码实现 → 代码审查
→ 质量验证 → 交付验收 → 变更质检与部署 → 持续迭代
```

当前仓库提供一个可运行的 **TypeScript-first** MVP 控制面和扩展 SDK，不替代现有研发平台。核心框架、CLI、内置 Skills 和测试均使用 TypeScript；只有第三方能力仅提供 Python SDK 时，才通过语言无关的外部进程或服务协议接入。

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
- CLI、JSON 文件状态存储和执行审计记录；
- 可视化 Web 控制台：变更导航、12 阶段时间线、证据门禁、Skills、Workflows 和运行记录；
- 统一任务看板：以同一七状态模型聚合 CJHX 本地草稿、Jira 任务投影以及 GitHub/GitLab issue 和 PR/MR；支持全局或 Workspace 范围、来源、类型、变更、Owner、风险和状态筛选；
- DevOps 控制面：展示流水线和运行状态、制品版本、服务状态，并通过显式审批触发 CI/CD 或启停服务；
- 集成配置中心：在 UI 中测试、保存、更新或移除 Jira、DevOps、GitLab 与 GitHub Adapter，凭据不回显；GitLab/GitHub 可分别保存并选择当前代码托管 Provider；
- Workspace Hub：以 Workspace 为范围提供 Overview、Kanban、Sessions、Team 和 Codebase 视图；Kanban 与全局任务看板复用同一投影和交互；支持导入/移除本地 Git 仓库，搜索文件，管理经审批的 worktree 与 Git refs，浏览并检查提交；
- 虚拟 Workspace：无需克隆即可导入已配置的 GitLab/GitHub 仓库，实时浏览目录、文件、refs、提交、issue、PR/MR 和评论。

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

要求 Node.js 20+。

```bash
cd cjhx-agile-workflow
npm install --include=dev
npm run build
npm link

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

### 启动可视化控制台

```bash
cjhx --workspace .cjhx ui
# 或在源码仓库中
npm run ui
```

控制台默认打开 `http://127.0.0.1:4317`。可使用 `--port` 更换端口，或用 `--no-open` 禁止自动打开浏览器。服务器仅允许监听回环地址；所有写请求都需要页面会话 Token。详见 [UI 使用与安全边界](docs/UI.md)。

框架状态默认保存到 `.cjhx/`：

```text
.cjhx/
├── changes/            # 变更状态与证据索引
├── skills/             # 已安装的不可变 Skill 包
├── skills-lock.json    # 版本与摘要锁定
├── runs/               # Skill 和 Workflow 执行记录
├── tasks/              # 未发布任务草稿和 Jira 任务状态投影
├── workspaces/         # 本地仓库引用和虚拟仓库元数据；不复制远端事实
└── integrations/       # 本地 Adapter 配置；凭据文件权限为 0600
```

业务事实仍保存在其权威平台中；`.cjhx` 不复制 Jira、Confluence、DevOps 或代码托管平台的完整业务数据。虚拟 Workspace 每次通过对应 Adapter 实时读取远端投影。

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
├── main.mjs            # 可选外部进程入口；也可使用其他语言
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
npm run typecheck       # TypeScript strict mode
npm test                # 构建并运行 Node 原生测试
npm run check           # 完整检查
```

如果当前 shell 设置了 `NODE_ENV=production`，安装开发工具时需要显式使用 `npm install --include=dev`。

## 文档

- [架构与边界](docs/ARCHITECTURE.md)
- [Skill 开发与治理](docs/SKILLS.md)
- [Jira、Confluence、代码托管、博云和观测适配](docs/INTEGRATIONS.md)
- [可视化控制台](docs/UI.md)

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
