# dsh-issue-bot

[中文](#中文) · [English](#english)

一个 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 宿主插件:监听 GitHub 仓库的新 issue,自动派发一个 agent 去处理;处理过程作为**普通对话**保留在对应工作区(workspace)下,由人审阅后决定是否归档。

适合"私有地址机器":内置**轮询模式**,通过本机 `gh` 登录拉取 GitHub API,**不需要任何入站连接**(无需公网 IP、端口映射或隧道);webhook 入口同时保留,两种模式可共存。

## 中文

### 功能

- **两种触发方式**
  - 轮询(推荐用于内网机器):`gh api` 定时拉取 open issues,只处理"启动之后新建"的 issue;重启后可在补账窗口内回捞停机期间的新 issue(`backfillMs`);reopened 的老 issue 不会误触发
  - Webhook:`POST /webhook/issues`,兼容 GitHub / Gitee 的 `issues` 事件与 GitLab issue hook,仅接受新建动作(opened/open),按 delivery id 去重
- **仓库 → 工作区映射**:每个仓库可指定本地 checkout 目录,agent 在对应代码库里调查、修改(不 commit / 不 push),产出中文处理报告(结论 / 已做修改 / 建议后续动作)
- **模型与思考强度可选**:issue agent 可固定使用指定 provider/模型,并指定思考强度(reasoning effort);全留空则跟随 GUI 默认模型选择。保存时校验模型路由可解析、强度在所选模型支持列表内
- **提示词模板可配置**:派发给 agent 的提示词是一份可编辑模板,占位符 `{{repo}}`、`{{number}}`、`{{title}}`、`{{body}}`、`{{url}}`(允许两侧空白);单遍插值,issue 正文里出现的占位符不会被展开;`{{body}}` 自动截断到 24000 字符
- **对话保留**:处理会话与浏览器里手动开的会话走同一条创建路径(默认 preset + 默认模型 + workspace cwd),完成后留在工作区会话列表里,归档完全由人决定
- **管理页**:`/webhook/issues/panel`,配置读写 + 实时状态(最近轮询、错误、处理历史),保存前逐项**验证**(仓库真实可访问 via `gh api`、工作区路径真实存在且是目录),任一失败拒绝保存且不影响现有配置
- **配置落盘**:`~/.dsh/issue-bot.config.json`,重启不丢

### 安装

前提:已安装 dsh(工作区能跑 `pnpm dsh web`)、`gh` 已登录、Node ≥ 22。

```sh
# 方式一:直接从 GitHub 安装
pnpm dsh plugin --profile web add github:Lixiang9716/dsh-issue-bot

# 方式二:克隆后本地安装(便于改源码)
git clone https://github.com/Lixiang9716/dsh-issue-bot ~/dsh-issue-bot
pnpm dsh plugin --profile web add ~/dsh-issue-bot
```

重启 `dsh web` 生效。卸载:`pnpm dsh plugin --profile web remove dsh-issue-bot` 后重启。

### 首次配置

1. 打开管理页:`http://127.0.0.1:3080/webhook/issues/panel`
2. 访问 Token 一栏填入当前 token(首次为 `change-me`,**请立即更换**,如 `openssl rand -hex 24`),点击"读取配置"
3. 按行填写监听仓库:`owner/repo`,可在同一行跟一个空格 + 本地工作区绝对路径,例如:

   ```
   Lixiang9716/govrail  /home/lx/govrail
   Lixiang9716/radiant  /home/lx/radiant
   ```

   不写路径的仓库使用"默认工作区"
4. 点击"保存设置"——插件会逐项验证(github 可访问、路径存在),全部通过才生效并落盘

### 如何触发一个 issue(Example)

**方式 A:在 GitHub 上开 issue(轮询模式的标准用法)**

```sh
# 用 gh CLI 在被监听的仓库上开一个 issue
gh issue create --repo Lixiang9716/govrail \
  --title '修复:登录页在密码为空时崩溃' \
  --body '复现步骤:
1. 打开登录页
2. 密码留空,直接点击登录
预期:提示"请输入密码";实际:页面白屏,console 抛 TypeError'

# 也可以直接在 GitHub 网页上点 New issue,效果相同
```

接下来会发生什么(默认 60 秒轮询一次):

1. 插件在下一次轮询检出该 issue(管理页"最近处理"出现 `running` 条目)
2. 在映射的工作区(上例为 `/home/lx/govrail`)创建一个普通会话,agent 开始调查并处理
3. 完成后状态变 `done`;在 dsh GUI 左侧对应工作区下会出现这段对话,内含处理报告
4. **由你决定**是否继续追问、采纳修改,或在 GUI 中归档该会话

**方式 B:webhook 直接触发(需要 GitHub 能访问到本机,如经隧道)**

```sh
curl -X POST 'http://127.0.0.1:3080/webhook/issues?token=<你的token>' \
  -H 'content-type: application/json' \
  -H 'x-github-event: issues' \
  -d '{"action":"opened","issue":{"number":101,"title":"webhook 演示","body":"请直接输出确认报告","html_url":"https://github.com/Lixiang9716/govrail/issues/101"},"repository":{"full_name":"Lixiang9716/govrail"}}'
```

GitHub 仓库配置:Settings → Webhooks → Add webhook,Payload URL 填 `https://<隧道域名>/webhook/issues?token=<你的token>`,Content type 选 `application/json`,触发选 Issues。

### 安全说明

- 管理页的配置读写接口与 webhook 入口共用同一个 token 鉴权(`?token=` 或 `x-webhook-token` 头);token 留空 = 完全关闭鉴权,**不建议**(本机恶意网页可跨站 POST)
- dsh 默认只监听 `127.0.0.1`,外网不可达;暴露到公网前务必设置强 token
- token 只存在于本机 `~/.dsh/issue-bot.config.json`,不会出现在任何日志

### 架构

宿主平面(host-plane)插件:不提供任何服务,消费 `webServer` / `agents` / `timer` / `shell`,以 `dsh.bundle` 补丁层形式进入 profile 组合。新 issue → `agents.create`(默认 preset + `agentDefaultModel` 选择)→ `followup` 派发任务 → `whenIdle` 等待完成。

## English

A DeepSeek Harness host-plane plugin that watches GitHub repos for new issues and dispatches an agent to handle each one. The handling conversation persists as a normal session under the mapped workspace; archiving stays a human decision.

Ships with a **poll mode** for machines behind NAT (uses the local `gh` login against the GitHub API — zero inbound connectivity required) plus a webhook endpoint (GitHub / Gitee / GitLab payloads, new-issue actions only, delivery dedupe). A built-in admin page (`/webhook/issues/panel`) edits config with pre-save verification (repo reachable, workspace paths exist) and persists to `~/.dsh/issue-bot.config.json`.

```sh
pnpm dsh plugin --profile web add github:Lixiang9716/dsh-issue-bot
# restart dsh web, open http://127.0.0.1:3080/webhook/issues/panel
```

Trigger example:

```sh
gh issue create --repo <owner>/<repo> --title 'Bug: ...' --body 'Steps: ...'
# within one poll interval an agent session appears under the mapped workspace
```

## License

[MIT](LICENSE)
