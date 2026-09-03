/**
 * dsh-issue-bot — Issue 监听(常驻部署版)。
 *
 * 宿主平面插件:不提供任何服务,消费 webServer / agents / timer / shell。
 * - webhook 入口:POST <routePath>(GitHub/Gitee issues 事件、GitLab issue hook)
 * - 轮询模式:gh api 定时拉取 open issues(私有地址机器无需入站连接)
 * - 新 issue → 在映射的工作区目录创建普通会话并派发 agent,完成后会话
 *   保留在工作区列表中,由人决定是否归档
 * - 管理页:<routePath>/panel(配置读写,保存前验证仓库可访问与路径存在)
 * - 配置落盘:(DSH_HOME ?? HOME/.dsh)/issue-bot.config.json
 */

import { readFile, writeFile, rename, stat as fsStat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-issue-bot'

export const inject = ['webServer', 'agents', 'timer']

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME ?? '/home/lx', '.dsh')
const CONFIG_PATH = join(DSH_HOME, 'issue-bot.config.json')
const LIMITS = { maxBodyBytes: 5242880, historyLimit: 50, maxIssueBodyChars: 24000 }
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// 默认 Agent 提示词模板。占位符(允许两侧空白):{{repo}} {{number}} {{title}} {{body}} {{url}}
const DEFAULT_PROMPT_TEMPLATE = [
  '自动派发的 issue 处理任务:{{repo}} #{{number}}',
  '',
  '# {{title}}',
  '',
  '{{body}}',
  '',
  '链接: {{url}}',
  '',
  '你是该仓库工作区中的自动维护助手。本消息由 issue 监听自动触发,当前没有人在场:',
  '1. 在仓库内调查这个 issue:定位根因,或回答它提出的问题;',
  '2. 需要修改时直接在工作区内修改,不要执行 git commit / git push;',
  '3. 不要向用户提问;自行决策,把不确定的假设写进最终报告;',
  '4. 结束时输出中文处理报告:结论或根因、已做的修改(涉及的文件)、建议的人工后续动作。',
  '完成后正常结束。这段对话会作为普通会话保留在工作区中,由人来审阅并决定是否归档。',
].join('\n')

// 首次启动的种子配置(文件存在则以文件为准)。公开发布的模板值:
// token 必须在管理页换成强随机值;仓库与工作区映射全部经管理页配置。
const DEFAULTS = {
  routePath: '/webhook/issues',
  token: 'change-me',
  defaultWorkspace: join(process.env.HOME ?? '/home', 'dsh-issue-workspace'),
  repoWorkspaces: {},
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  poll: {
    repos: [],
    intervalMs: 60000,
    backfillMs: 30 * 60 * 1000,
  },
}

export function apply(ctx) {
  const state = { config: structuredClone(DEFAULTS) }
  const history = []
  const seenDeliveries = new Map()
  const pollState = new Map()
  let triggerCutoff = Date.now() - state.config.poll.backfillMs
  let pollInFlight = false
  let pollDisposer = null
  let panelHtml = '<!doctype html><meta charset="utf-8"><title>Issue 监听管理</title><p>panel.html 缺失</p>'

  // ===== 配置持久化 =====
  async function loadConfigFromDisk() {
    try {
      const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'))
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const poll = raw.poll ?? {}
        state.config = {
          routePath: typeof raw.routePath === 'string' && raw.routePath !== '' ? raw.routePath : DEFAULTS.routePath,
          token: typeof raw.token === 'string' ? raw.token : DEFAULTS.token,
          defaultWorkspace: typeof raw.defaultWorkspace === 'string' && raw.defaultWorkspace !== '' ? raw.defaultWorkspace : DEFAULTS.defaultWorkspace,
          repoWorkspaces: raw.repoWorkspaces !== null && typeof raw.repoWorkspaces === 'object' && !Array.isArray(raw.repoWorkspaces)
            ? raw.repoWorkspaces
            : {},
          promptTemplate: typeof raw.promptTemplate === 'string' && raw.promptTemplate.trim() !== ''
            ? raw.promptTemplate
            : DEFAULT_PROMPT_TEMPLATE,
          poll: {
            repos: Array.isArray(poll.repos) ? poll.repos.filter((repo) => typeof repo === 'string') : [],
            intervalMs: typeof poll.intervalMs === 'number' && poll.intervalMs >= 15000 ? poll.intervalMs : 60000,
            backfillMs: typeof poll.backfillMs === 'number' && poll.backfillMs >= 0 ? poll.backfillMs : 0,
          },
        }
        triggerCutoff = Date.now() - state.config.poll.backfillMs
      }
    } catch (error) {
      // 文件不存在或损坏:写入种子配置
      await persistConfig().catch(() => {})
    }
  }

  async function persistConfig() {
    const tmp = CONFIG_PATH + '.tmp'
    await writeFile(tmp, JSON.stringify(state.config, null, 2) + '\n', 'utf-8')
    await rename(tmp, CONFIG_PATH)
  }

  // ===== HTTP 基础 =====
  function send(res, status, payload, type) {
    if (res.writableEnded) return
    res.writeHead(status, {
      'content-type': type ?? 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
  }

  function header(headers, name) {
    const value = headers[name]
    return Array.isArray(value) ? value.join(',') : value
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const parts = []
      let total = 0
      let settled = false
      req.on('data', (chunk) => {
        if (settled) return
        total += chunk.length
        if (total > limit) {
          settled = true
          reject(new Error('request body exceeds ' + limit + ' bytes'))
          req.destroy()
          return
        }
        parts.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(parts).toString('utf-8'))
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
  }

  function authorized(url, headers) {
    if (state.config.token === '') return true
    const supplied = url.searchParams.get('token') ?? header(headers, 'x-webhook-token') ?? null
    return supplied === state.config.token
  }

  // ===== 载荷识别 =====
  function extractIssue(headers, body) {
    if (body === null || typeof body !== 'object') return { skip: 'body is not a JSON object' }
    const eventHeader = header(headers, 'x-github-event')
    if (eventHeader !== undefined && eventHeader !== 'issues' && eventHeader !== 'issue') {
      return { skip: 'event "' + eventHeader + '" ignored (only issue events)' }
    }
    const ghIssue = body.issue
    if (ghIssue !== null && ghIssue !== undefined && typeof ghIssue === 'object') {
      if (body.action !== 'opened' && body.action !== 'open') {
        return { skip: 'issue action "' + body.action + '" ignored (only new issues)' }
      }
      const repo = body.repository ?? {}
      return {
        issue: {
          repo: repo.full_name ?? repo.path_with_namespace ?? repo.name ?? 'unknown',
          number: Number(ghIssue.number ?? ghIssue.iid ?? ghIssue.id ?? 0),
          title: String(ghIssue.title ?? '(untitled)'),
          bodyText: typeof ghIssue.body === 'string' ? ghIssue.body : (typeof ghIssue.description === 'string' ? ghIssue.description : ''),
          url: String(ghIssue.html_url ?? ghIssue.url ?? ''),
        },
      }
    }
    if (body.object_kind === 'issue' && body.object_attributes !== null && typeof body.object_attributes === 'object') {
      const attr = body.object_attributes
      if (attr.action !== undefined && attr.action !== 'open') {
        return { skip: 'issue action "' + attr.action + '" ignored (only new issues)' }
      }
      const repo = body.repository ?? body.project ?? {}
      return {
        issue: {
          repo: repo.path_with_namespace ?? repo.full_name ?? repo.name ?? 'unknown',
          number: Number(attr.iid ?? attr.id ?? 0),
          title: String(attr.title ?? '(untitled)'),
          bodyText: typeof attr.description === 'string' ? attr.description : '',
          url: String(attr.url ?? ''),
        },
      }
    }
    return { skip: 'no issue payload recognized (expected GitHub/Gitee issues event or GitLab issue hook)' }
  }

  function buildPrompt(issue) {
    let bodyText = issue.bodyText
    if (bodyText.length > LIMITS.maxIssueBodyChars) {
      bodyText = bodyText.slice(0, LIMITS.maxIssueBodyChars) + '\n…(issue 正文过长,已截断)'
    }
    if (bodyText === '') bodyText = '(无正文)'
    const values = {
      repo: issue.repo,
      number: String(issue.number),
      title: issue.title,
      body: bodyText,
      url: issue.url !== '' ? issue.url : '(无链接)',
    }
    const template = typeof state.config.promptTemplate === 'string' && state.config.promptTemplate.trim() !== ''
      ? state.config.promptTemplate
      : DEFAULT_PROMPT_TEMPLATE
    // 单遍替换:插入的值不会被再次扫描,issue 正文里的 {{…}} 不会被展开
    return template.replace(/\{\{\s*(repo|number|title|body|url)\s*\}\}/g, (match, key) => values[key])
  }

  // ===== 去重与派发 =====
  function markSeen(key) {
    if (seenDeliveries.has(key)) return false
    seenDeliveries.set(key, Date.now())
    if (seenDeliveries.size > 500) seenDeliveries.delete(seenDeliveries.keys().next().value)
    return true
  }

  function record(entry) {
    history.unshift(entry)
    if (history.length > LIMITS.historyLimit) history.length = LIMITS.historyLimit
  }

  async function handleIssue(entry, issue) {
    const presets = ctx.get('agentPresets')
    const workspaces = ctx.get('workspaceRegistry')
    const cwd = Object.prototype.hasOwnProperty.call(state.config.repoWorkspaces, issue.repo)
      ? state.config.repoWorkspaces[issue.repo]
      : state.config.defaultWorkspace
    entry.workspace = cwd
    const modelService = ctx.get('agentDefaultModel')
    let agentOptions
    if (modelService !== undefined) {
      const selection = modelService.currentSelection()
      if (selection !== null && selection !== undefined
        && typeof selection.provider === 'string' && typeof selection.model === 'string'
        && selection.provider !== '' && selection.model !== '') {
        agentOptions = { provider: selection.provider, model: selection.model }
      }
    }
    if (agentOptions === undefined) {
      throw new Error('no usable default model selection (agentDefaultModel missing or empty); cannot start issue agent')
    }
    entry.model = agentOptions.provider + '/' + agentOptions.model
    let presetId
    if (presets !== undefined) presetId = (await presets.resolve()).id
    const sessionId = 'session-' + randomUUID()
    entry.sessionId = sessionId
    const createOptions = { sessionId, agentOptions, meta: { cwd } }
    if (presetId !== undefined) {
      createOptions.meta.agentPreset = presetId
      createOptions.setup = async (agentCtx) => { await presets.mount(agentCtx, presetId) }
    }
    const handle = await ctx.agents.create(createOptions)
    // 与 GUI 普通会话同路:创建后挂接到工作区(attach 校验 cwd 与工作区路径
    // 一致并前插进持久 sessionIds),否则会话会显示在"未分组"下
    if (workspaces !== undefined) {
      try {
        const workspace = await workspaces.create(cwd)
        await workspace.attachSession(handle.agent.id)
      } catch (error) {
        console.error('[issue-bot] workspace attach failed for ' + cwd + ': ' + String(error))
      }
    }
    handle.agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: buildPrompt(issue) }],
      source: { kind: 'user' },
    })
    console.log('[issue-bot] ' + issue.repo + ' #' + issue.number + ' -> agent ' + sessionId + ' on ' + entry.model + ' (workspace ' + cwd + ')')
    await handle.agent.whenIdle()
    entry.state = 'done'
    entry.finishedAt = Date.now()
    console.log('[issue-bot] ' + issue.repo + ' #' + issue.number + ' done; conversation ' + sessionId + ' kept for human review')
  }

  function dispatchIssue(issue) {
    const key = 'issue:' + issue.repo + '#' + issue.number + ':open'
    if (!markSeen(key)) return false
    const entry = {
      repo: issue.repo,
      number: issue.number,
      title: issue.title,
      source: issue.source ?? 'webhook',
      state: 'running',
      startedAt: Date.now(),
    }
    record(entry)
    handleIssue(entry, issue).catch((error) => {
      entry.state = 'error'
      entry.error = String(error && error.message ? error.message : error)
      entry.finishedAt = Date.now()
      console.error('[issue-bot] ' + issue.repo + ' #' + issue.number + ' failed: ' + entry.error)
    })
    return true
  }

  // ===== 轮询 =====
  async function pollRepo(repo) {
    const stateRow = pollState.get(repo) ?? { newestOpen: 0, lastPollAt: 0, lastError: null, listedOnce: false }
    pollState.set(repo, stateRow)
    try {
      const shell = ctx.get('shell')
      if (shell === undefined) throw new Error('shell service unavailable; cannot run gh api')
      const spec = shell.resolve({
        command: 'gh api "repos/' + repo + '/issues?state=open&sort=created&direction=desc&per_page=30"',
        workdir: state.config.defaultWorkspace,
        timeoutMs: 30000,
        stdoutMaxBytes: 2097152,
      })
      const result = await shell.run(spec)
      if (result.exitCode !== 0) {
        throw new Error('gh api exit ' + result.exitCode + ': ' + (result.stderr && result.stderr.text ? result.stderr.text.slice(0, 200) : '(no stderr)'))
      }
      const items = JSON.parse(result.stdout.text)
      if (!Array.isArray(items)) throw new Error('gh api returned non-array JSON')
      const pureIssues = items.filter((item) => item.pull_request === undefined)
      stateRow.newestOpen = pureIssues.length
      for (const item of pureIssues) {
        const key = 'issue:' + repo + '#' + item.number + ':open'
        if (seenDeliveries.has(key)) continue
        const createdMs = Date.parse(item.created_at ?? '') || 0
        if (!(createdMs >= triggerCutoff)) {
          markSeen(key)
          continue
        }
        const issue = {
          repo,
          number: Number(item.number ?? 0),
          title: String(item.title ?? '(untitled)'),
          bodyText: typeof item.body === 'string' ? item.body : '',
          url: String(item.html_url ?? ''),
          source: 'poll',
        }
        if (dispatchIssue(issue)) console.log('[issue-bot] poll detected ' + repo + ' #' + issue.number + ': ' + issue.title)
      }
      stateRow.listedOnce = true
      stateRow.lastPollAt = Date.now()
      stateRow.lastError = null
    } catch (error) {
      stateRow.lastError = String(error && error.message ? error.message : error)
      stateRow.lastPollAt = Date.now()
      console.error('[issue-bot] poll ' + repo + ' failed: ' + stateRow.lastError)
    }
  }

  async function pollTick() {
    if (pollInFlight) return
    pollInFlight = true
    try {
      for (const repo of state.config.poll.repos) {
        if (!REPO_PATTERN.test(repo)) {
          console.error('[issue-bot] invalid repo name in config poll.repos: ' + repo)
          continue
        }
        await pollRepo(repo)
      }
    } finally {
      pollInFlight = false
    }
  }

  function applyPollConfig() {
    if (pollDisposer !== null) {
      pollDisposer()
      pollDisposer = null
    }
    if (state.config.poll.repos.length > 0) {
      pollTick()
      pollDisposer = ctx.interval(pollTick, state.config.poll.intervalMs)
    }
  }

  // ===== 保存前可用性验证 =====
  async function verifyRepo(shell, repo) {
    try {
      const spec = shell.resolve({
        command: 'gh api "repos/' + repo + '"',
        workdir: state.config.defaultWorkspace,
        timeoutMs: 15000,
        stdoutMaxBytes: 65536,
      })
      const result = await shell.run(spec)
      if (result.exitCode !== 0) {
        const lines = (result.stderr && result.stderr.text ? result.stderr.text : '').split('\n').filter((line) => line.trim() !== '')
        const last = lines.length > 0 ? lines[lines.length - 1] : ''
        return { repo, ok: false, error: 'gh api 失败(exit ' + result.exitCode + (last !== '' ? ':' + last.slice(0, 120) : '') + ')' }
      }
      return { repo, ok: true, error: null }
    } catch (error) {
      return { repo, ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  async function verifyWorkspacePath(path) {
    try {
      const info = await fsStat(path)
      if (!info.isDirectory()) return { path, ok: false, error: '不是目录' }
      return { path, ok: true, error: null }
    } catch (error) {
      return { path, ok: false, error: error && error.code === 'ENOENT' ? '路径不存在' : String(error && error.message ? error.message : error) }
    }
  }

  // ===== 状态投影 =====
  function pollSummary() {
    return {
      enabled: state.config.poll.repos.length > 0,
      intervalMs: state.config.poll.intervalMs,
      backfillMs: state.config.poll.backfillMs,
      auth: 'gh CLI login',
      triggersOnlyIssuesCreatedAfter: new Date(triggerCutoff).toISOString(),
      repos: state.config.poll.repos.map((repo) => {
        const row = pollState.get(repo)
        return {
          repo,
          workspace: Object.prototype.hasOwnProperty.call(state.config.repoWorkspaces, repo)
            ? state.config.repoWorkspaces[repo]
            : state.config.defaultWorkspace,
          newestOpen: row === undefined ? 0 : row.newestOpen,
          lastPollAt: row === undefined ? 0 : row.lastPollAt,
          listedOnce: row !== undefined && row.listedOnce === true,
          lastError: row === undefined || row.lastError == null ? null : String(row.lastError),
        }
      }),
    }
  }

  function statusView() {
    return {
      running: history.filter((entry) => entry.state === 'running').length,
      history: history.map((entry) => ({
        repo: entry.repo,
        number: entry.number,
        title: entry.title,
        source: entry.source,
        state: entry.state,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt ?? null,
        workspace: entry.workspace ?? null,
        model: entry.model ?? null,
        sessionId: entry.sessionId ?? null,
        error: entry.error ?? null,
      })),
    }
  }

  function statusPayload() {
    const server = ctx.webServer
    return {
      ok: true,
      name: 'dsh-issue-bot',
      webhook: {
        url: 'http://' + server.host + ':' + server.port + state.config.routePath,
        method: 'POST',
        auth: 'query ?token= 或 header x-webhook-token',
        accepts: 'GitHub/Gitee issues 事件、GitLab issue hook;仅接受新建(opened/open)动作;重复投递自动去重',
      },
      poll: pollSummary(),
      config: {
        routePath: state.config.routePath,
        tokenIsSet: state.config.token !== '',
        defaultWorkspace: state.config.defaultWorkspace,
        repoWorkspaces: state.config.repoWorkspaces,
      },
      ...statusView(),
    }
  }

  // ===== 配置读写(管理 API) =====
  async function setConfig(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: '配置必须是对象' }
    }
    const next = {
      repos: [...state.config.poll.repos],
      repoWorkspaces: { ...state.config.repoWorkspaces },
      defaultWorkspace: state.config.defaultWorkspace,
      intervalMs: state.config.poll.intervalMs,
      backfillMs: state.config.poll.backfillMs,
      token: state.config.token,
      promptTemplate: state.config.promptTemplate,
    }
    try {
      if (patch.repos !== undefined) {
        if (!Array.isArray(patch.repos)) throw new Error('repos 必须是数组')
        const seen = new Set()
        const repos = []
        for (const repo of patch.repos) {
          if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) throw new Error('仓库格式应为 owner/repo:' + String(repo))
          if (!seen.has(repo)) {
            seen.add(repo)
            repos.push(repo)
          }
        }
        next.repos = repos
      }
      if (patch.repoWorkspaces !== undefined) {
        if (patch.repoWorkspaces === null || typeof patch.repoWorkspaces !== 'object' || Array.isArray(patch.repoWorkspaces)) throw new Error('repoWorkspaces 必须是对象')
        for (const key of Object.keys(patch.repoWorkspaces)) {
          const value = patch.repoWorkspaces[key]
          if (!REPO_PATTERN.test(key)) throw new Error('repoWorkspaces 键格式应为 owner/repo:' + key)
          if (typeof value !== 'string' || value.charAt(0) !== '/') throw new Error('工作区路径必须是绝对路径:' + key + ' -> ' + String(value))
        }
        next.repoWorkspaces = { ...patch.repoWorkspaces }
      }
      if (patch.defaultWorkspace !== undefined) {
        if (typeof patch.defaultWorkspace !== 'string' || patch.defaultWorkspace.charAt(0) !== '/') throw new Error('默认工作区必须是绝对路径')
        next.defaultWorkspace = patch.defaultWorkspace
      }
      if (patch.intervalMs !== undefined) {
        if (typeof patch.intervalMs !== 'number' || !Number.isFinite(patch.intervalMs) || patch.intervalMs < 15000 || patch.intervalMs > 3600000) throw new Error('轮询间隔需在 15–3600 秒之间')
        next.intervalMs = patch.intervalMs
      }
      if (patch.backfillMs !== undefined) {
        if (typeof patch.backfillMs !== 'number' || !Number.isFinite(patch.backfillMs) || patch.backfillMs < 0 || patch.backfillMs > 604800000) throw new Error('补账窗口需在 0–7 天之间')
        next.backfillMs = patch.backfillMs
      }
      if (patch.token !== undefined) {
        if (typeof patch.token !== 'string') throw new Error('token 必须是字符串')
        next.token = patch.token
      }
      if (patch.promptTemplate !== undefined) {
        if (typeof patch.promptTemplate !== 'string' || patch.promptTemplate.trim() === '') throw new Error('提示词模板必须是非空字符串')
        if (patch.promptTemplate.length > 50000) throw new Error('提示词模板过长(上限 50000 字符)')
        next.promptTemplate = patch.promptTemplate
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }

    const failures = []
    if (next.repos.length > 0) {
      const shell = ctx.get('shell')
      if (shell === undefined) {
        failures.push('shell 服务不可用,无法验证仓库(gitHub API)')
      } else {
        const checks = await Promise.all(next.repos.map((repo) => verifyRepo(shell, repo)))
        for (const check of checks) {
          if (!check.ok) failures.push('仓库 ' + check.repo + ':' + check.error)
        }
      }
    }
    const pathSet = new Set([next.defaultWorkspace])
    for (const path of Object.values(next.repoWorkspaces)) pathSet.add(path)
    const pathChecks = await Promise.all([...pathSet].map((path) => verifyWorkspacePath(path)))
    for (const check of pathChecks) {
      if (!check.ok) failures.push('工作区 ' + check.path + ':' + check.error)
    }
    if (failures.length > 0) {
      console.error('[issue-bot] config rejected by verification: ' + failures.join(' | '))
      return { ok: false, error: '配置未保存,以下检查未通过:\n' + failures.join('\n') }
    }

    state.config.poll = { repos: next.repos, intervalMs: next.intervalMs, backfillMs: next.backfillMs }
    state.config.repoWorkspaces = next.repoWorkspaces
    state.config.defaultWorkspace = next.defaultWorkspace
    state.config.token = next.token
    state.config.promptTemplate = next.promptTemplate
    triggerCutoff = Date.now() - state.config.poll.backfillMs
    applyPollConfig()
    await persistConfig()
    console.log('[issue-bot] config verified, persisted, and applied: repos=[' + state.config.poll.repos.join(', ') + ']')
    return {
      ok: true,
      message: '已验证并生效(已落盘):' + next.repos.length + ' 个仓库可访问,' + pathSet.size + ' 个工作区路径有效',
    }
  }

  // ===== HTTP 处理 =====
  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const base = state.config.routePath

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === base) {
        send(res, 200, statusPayload())
        return
      }
      if (path === base + '/panel') {
        send(res, 200, panelHtml, 'text/html; charset=utf-8')
        return
      }
      if (path === base + '/config') {
        if (!authorized(url, req.headers)) {
          send(res, 401, { ok: false, error: 'unauthorized: supply ?token= or x-webhook-token header' })
          return
        }
        send(res, 200, { ok: true, config: state.config, poll: pollSummary() })
        return
      }
      send(res, 404, { ok: false, error: 'not found' })
      return
    }

    if (req.method !== 'POST') {
      send(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    if (path === base + '/config') {
      if (!authorized(url, req.headers)) {
        send(res, 401, { ok: false, error: 'unauthorized: supply ?token= or x-webhook-token header' })
        return
      }
      let patch
      try {
        patch = JSON.parse(await readBody(req, LIMITS.maxBodyBytes))
      } catch (error) {
        send(res, 400, { ok: false, error: 'invalid JSON body: ' + String(error && error.message ? error.message : error) })
        return
      }
      const result = await setConfig(patch)
      send(res, result.ok ? 200 : 422, result)
      return
    }

    if (path !== base) {
      send(res, 404, { ok: false, error: 'not found' })
      return
    }

    if (!authorized(url, req.headers)) {
      send(res, 401, { ok: false, error: 'unauthorized: supply ?token= or x-webhook-token header' })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req, LIMITS.maxBodyBytes))
    } catch (error) {
      send(res, 400, { ok: false, error: 'invalid JSON body: ' + String(error && error.message ? error.message : error) })
      return
    }
    const extracted = extractIssue(req.headers, body)
    if (extracted.skip !== undefined) {
      send(res, 200, { ok: true, skipped: extracted.skip })
      return
    }
    const issue = extracted.issue
    const delivery = header(req.headers, 'x-github-delivery') ?? header(req.headers, 'x-gitlab-event-uuid')
    if (delivery !== undefined && delivery !== null && delivery !== '') {
      if (!markSeen('delivery:' + delivery)) {
        send(res, 200, { ok: true, skipped: 'duplicate delivery' })
        return
      }
    }
    const dispatched = dispatchIssue(issue)
    send(res, dispatched ? 202 : 200, {
      ok: true,
      ...(dispatched ? { accepted: true } : { skipped: 'duplicate issue' }),
      issue: { repo: issue.repo, number: issue.number, title: issue.title },
      note: 'agent session starting; GET this URL for live status',
    })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: state.config.routePath, handler }))
  void loadConfigFromDisk().then(() => {
    applyPollConfig()
    console.log('[issue-bot] deployed via profile bundle; panel: ' + state.config.routePath + '/panel, config file: ' + CONFIG_PATH)
  })
  void readFile(new URL('./panel.html', import.meta.url), 'utf-8').then(
    (html) => { panelHtml = html },
    (error) => { console.error('[issue-bot] panel.html unreadable: ' + String(error)) },
  )
}
