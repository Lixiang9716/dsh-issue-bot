window.__ModuleLoader__.load({
  id: 'dsh-issue-bot',
  factory: (require) => {
    const React = require('react')
    const e = React.createElement

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '680px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #888)' },
      input: {
        font: 'inherit', border: '1px solid var(--dsw-alias-border-standard, #bbb)', borderRadius: '6px',
        padding: '6px 8px', width: '100%', boxSizing: 'border-box', background: 'transparent', color: 'inherit',
      },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #999)', fontWeight: 400 },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      btn: {
        font: 'inherit', border: '1px solid var(--dsw-alias-border-standard, #888)', borderRadius: '6px',
        padding: '5px 16px', background: 'var(--dsw-alias-bg-emphasize, #e8e8e8)', color: 'inherit', cursor: 'pointer',
      },
      ok: { color: '#2e7d32', fontSize: '12px', whiteSpace: 'pre-line' },
      err: { color: '#c62828', fontSize: '12px', whiteSpace: 'pre-line' },
      panel: {
        border: '1px solid var(--dsw-alias-border-standard, #ddd)', borderRadius: '8px',
        padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px',
      },
      title: { fontWeight: 600 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', wordBreak: 'break-all' },
      dim: { color: 'var(--dsw-alias-label-tertiary, #999)', fontSize: '11px' },
    }
    const textAreaStyle = Object.assign({}, S.input, {
      minHeight: '88px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', resize: 'vertical',
    })
    const errLine = { color: '#c62828' }

    function IssueBotSettings(props) {
      const seeded = React.useRef(false)
      const [apiToken, setApiToken] = React.useState('')
      const [reposText, setReposText] = React.useState('')
      const [defaultWorkspace, setDefaultWorkspace] = React.useState('')
      const [intervalSec, setIntervalSec] = React.useState('60')
      const [backfillMin, setBackfillMin] = React.useState('30')
      const [webhookToken, setWebhookToken] = React.useState('')
      const [promptTpl, setPromptTpl] = React.useState('')
      const [modelCatalog, setModelCatalog] = React.useState({ providers: [], defaultSelection: null })
      const [modelProvider, setModelProvider] = React.useState('')
      const [modelId, setModelId] = React.useState('')
      const [modelEffort, setModelEffort] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [checking, setChecking] = React.useState(false)

      function applyConfig(c, options) {
        setReposText((c.poll.repos || []).map(function (r) {
          return c.repoWorkspaces && c.repoWorkspaces[r] ? r + '  ' + c.repoWorkspaces[r] : r
        }).join('\n'))
        setDefaultWorkspace(String(c.defaultWorkspace ?? ''))
        setIntervalSec(String(Math.round((c.poll.intervalMs || 60000) / 1000)))
        setBackfillMin(String(Math.round((c.poll.backfillMs || 0) / 60000)))
        setWebhookToken(String(c.token ?? ''))
        setPromptTpl(String(c.promptTemplate ?? ''))
        if (options !== undefined && options !== null) {
          setModelCatalog({ providers: options.providers || [], defaultSelection: options.defaultSelection || null })
        }
        const m = c.model ?? {}
        setModelProvider(String(m.provider ?? ''))
        setModelId(String(m.model ?? ''))
        setModelEffort(String(m.reasoningEffort ?? ''))
      }

      function authUrl(base, token) {
        return base + (base.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token)
      }

      async function reload() {
        const token = apiToken.trim()
        if (token === '') return
        try {
          const [configRes, statusRes] = await Promise.all([
            fetch(authUrl('webhook/issues/config', token), { cache: 'no-store' }),
            fetch('webhook/issues', { cache: 'no-store' }),
          ])
          const configData = await configRes.json()
          const statusData = await statusRes.json()
          if (configData && configData.ok) {
            if (!seeded.current) {
              seeded.current = true
              applyConfig(configData.config, configData.modelOptions)
            }
          } else {
            setMessage({ kind: 'error', text: (configData && configData.error) || '配置读取失败(检查访问 Token)' })
          }
          if (statusData && statusData.ok) setStatus(statusData)
        } catch (error) {
          setMessage({ kind: 'error', text: '读取失败:' + String(error && error.message ? error.message : error) })
        }
      }

      React.useEffect(function () {
        const saved = window.localStorage.getItem('issuebot-token')
        if (saved !== null && saved !== '') {
          setApiToken(saved)
        }
      }, [])

      async function save() {
        if (checking) return
        setMessage(null)
        const token = apiToken.trim()
        if (token === '') {
          setMessage({ kind: 'error', text: '请先填写访问 Token(即 Webhook Token)' })
          return
        }
        const repos = []
        const repoWorkspaces = {}
        for (const raw of reposText.split('\n')) {
          const line = raw.trim()
          if (line === '') continue
          const parts = line.split(/\s+/)
          if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parts[0])) {
            setMessage({ kind: 'error', text: '仓库格式应为 owner/repo:' + line })
            return
          }
          if (parts.length > 2) {
            setMessage({ kind: 'error', text: '每行最多两个值(仓库 + 工作区路径):' + line })
            return
          }
          if (parts.length === 2 && parts[1].charAt(0) !== '/') {
            setMessage({ kind: 'error', text: '工作区路径必须是绝对路径:' + parts[1] })
            return
          }
          repos.push(parts[0])
          if (parts.length === 2) repoWorkspaces[parts[0]] = parts[1]
        }
        const interval = Number(intervalSec)
        const backfill = Number(backfillMin)
        if (!Number.isFinite(interval) || interval < 15 || interval > 3600) {
          setMessage({ kind: 'error', text: '轮询间隔需在 15–3600 秒之间' })
          return
        }
        if (!Number.isFinite(backfill) || backfill < 0 || backfill > 10080) {
          setMessage({ kind: 'error', text: '补账窗口需在 0–10080 分钟之间' })
          return
        }
        if (defaultWorkspace.charAt(0) !== '/') {
          setMessage({ kind: 'error', text: '默认工作区必须是绝对路径(以 / 开头)' })
          return
        }
        window.localStorage.setItem('issuebot-token', token)
        setChecking(true)
        try {
          const response = await fetch(authUrl('webhook/issues/config', token), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              repos,
              repoWorkspaces,
              defaultWorkspace,
              intervalMs: Math.round(interval * 1000),
              backfillMs: Math.round(backfill * 60000),
              token: webhookToken,
              promptTemplate: promptTpl,
              model: { provider: modelProvider, model: modelId, reasoningEffort: modelEffort },
            }),
          })
          const result = await response.json()
          if (result && result.ok) {
            setMessage({ kind: 'ok', text: result.message ?? '已验证并保存(已落盘)' })
            await reload()
          } else {
            setMessage({ kind: 'error', text: (result && result.error) || '保存失败' })
          }
        } catch (error) {
          setMessage({ kind: 'error', text: '保存失败:' + String(error && error.message ? error.message : error) })
        } finally {
          setChecking(false)
        }
      }

      let workspacePaths = null
      if (typeof props.useWorkspaces === 'function') {
        try {
          const ws = props.useWorkspaces()
          if (ws && Array.isArray(ws.items)) workspacePaths = ws.items.map(function (item) { return item.path })
        } catch (error) { workspacePaths = null }
      }

      const poll = status ? status.poll : null
      const historyRows = status && status.history ? status.history.slice(0, 8) : []

      return e('div', { style: S.root },
        e('div', { style: S.hint },
          '轮询监听 GitHub 仓库新 issue(gh 鉴权,无需入站连接);webhook 入口保留。保存前逐项验证;配置落盘于 ~/.dsh/issue-bot.config.json。完整管理页:/webhook/issues/panel'),
        e('label', { style: S.field },
          e('span', { style: S.label }, '访问 Token(用于调用配置接口)'),
          e('input', {
            style: S.input, type: 'password', value: apiToken, spellCheck: false, autoComplete: 'off',
            onChange: function (ev) { setApiToken(ev.target.value) },
            onBlur: function () { void reload() },
          }),
        ),
        e('label', { style: S.field },
          e('span', { style: S.label }, '监听仓库'),
          e('textarea', {
            style: textAreaStyle, value: reposText, spellCheck: false,
            placeholder: 'owner/repo  /absolute/path/to/workspace',
            onChange: function (ev) { setReposText(ev.target.value) },
          }),
          e('span', { style: S.hint }, '每行:owner/repo,可跟空格 + 本地工作区绝对路径;不写则用默认工作区'),
        ),
        e('label', { style: S.field },
          e('span', { style: S.label }, '默认工作区'),
          e('input', {
            style: S.input, type: 'text', value: defaultWorkspace, spellCheck: false,
            onChange: function (ev) { setDefaultWorkspace(ev.target.value) },
          }),
          workspacePaths !== null && workspacePaths.length > 0
            ? e('span', { style: S.row },
                e('span', { style: S.dim }, '已有工作区:'),
                workspacePaths.slice(0, 8).map(function (path) {
                  return e('button', {
                    key: path, type: 'button',
                    style: { font: 'inherit', fontSize: '11px', border: '1px solid #ccc', borderRadius: '999px', padding: '2px 10px', background: 'transparent', color: 'inherit', cursor: 'pointer', fontFamily: 'ui-monospace, monospace' },
                    onClick: function () { setDefaultWorkspace(path) },
                  }, path)
                }),
              )
            : null,
        ),
        e('div', { style: S.row },
          e('label', { style: Object.assign({}, S.field, { width: '160px' }) },
            e('span', { style: S.label }, '轮询间隔(秒)'),
            e('input', { style: S.input, type: 'number', min: '15', max: '3600', value: intervalSec, onChange: function (ev) { setIntervalSec(ev.target.value) } }),
          ),
          e('label', { style: Object.assign({}, S.field, { width: '200px' }) },
            e('span', { style: S.label }, '补账窗口(分钟)'),
            e('input', { style: S.input, type: 'number', min: '0', max: '10080', value: backfillMin, onChange: function (ev) { setBackfillMin(ev.target.value) } }),
            e('span', { style: S.hint }, '重启后回捞窗口内新建的 issue'),
          ),
        ),
        (function () {
          const providers = modelCatalog.providers || []
          const providerRow = providers.filter(function (p) { return p.id === modelProvider })[0]
          const models = providerRow ? providerRow.models : []
          const modelRow = models.filter(function (m) { return m.id === modelId })[0]
          const efforts = modelRow ? modelRow.efforts : []
          const def = modelCatalog.defaultSelection
          const defLabel = def
            ? '跟随默认(' + def.provider + '/' + def.model + (def.reasoningEffort ? ' · ' + def.reasoningEffort : '') + ')'
            : '跟随默认'
          const selectStyle = Object.assign({}, S.input, {})
          function optionList(value, items, fallbackLabel, rawLabel) {
            const options = [e('option', { key: '', value: '' }, fallbackLabel)]
            let matched = false
            for (const item of items) {
              options.push(e('option', { key: item.value, value: item.value }, item.label))
              if (item.value === value) matched = true
            }
            if (!matched && value !== '') options.push(e('option', { key: '__raw', value: value }, rawLabel(value)))
            return options
          }
          return e('div', { style: S.row },
            e('label', { style: Object.assign({}, S.field, { width: '180px' }) },
              e('span', { style: S.label }, '模型 · Provider'),
              e('select', {
                style: selectStyle, value: modelProvider,
                onChange: function (ev) { setModelProvider(ev.target.value); setModelId(''); setModelEffort('') },
              }, optionList(modelProvider, providers.map(function (p) { return { value: p.id, label: p.name || p.id } }), defLabel, function (v) { return v + '(目录外)' })),
            ),
            e('label', { style: Object.assign({}, S.field, { width: '180px' }) },
              e('span', { style: S.label }, '模型'),
              e('select', {
                style: selectStyle, value: modelId,
                onChange: function (ev) { setModelId(ev.target.value); setModelEffort('') },
              }, optionList(modelId, models.map(function (m) { return { value: m.id, label: m.name || m.id } }), modelProvider === '' ? '(随默认)' : '(请选择)', function (v) { return v + '(目录外)' })),
            ),
            e('label', { style: Object.assign({}, S.field, { width: '160px' }) },
              e('span', { style: S.label }, '思考强度'),
              e('select', {
                style: selectStyle, value: modelEffort,
                onChange: function (ev) { setModelEffort(ev.target.value) },
              }, optionList(modelEffort, efforts.map(function (x) { return { value: x.id, label: x.name || x.id } }), '模型默认', function (v) { return v + '(目录外)' })),
            ),
          )
        })(),
        e('label', { style: S.field },
          e('span', { style: S.label }, 'Webhook Token(留空 = 关闭鉴权)'),
          e('input', {
            style: S.input, type: 'text', value: webhookToken, spellCheck: false, autoComplete: 'off',
            onChange: function (ev) { setWebhookToken(ev.target.value) },
          }),
        ),
        e('label', { style: S.field },
          e('span', { style: S.label }, 'Agent 提示词模板'),
          e('textarea', {
            style: Object.assign({}, textAreaStyle, { minHeight: '180px' }),
            value: promptTpl, spellCheck: false,
            onChange: function (ev) { setPromptTpl(ev.target.value) },
          }),
          e('span', { style: S.hint }, '占位符:{{repo}} {{number}} {{title}} {{body}} {{url}};{{body}} 自动截断到 24000 字符,单遍插值(正文里的占位符不会展开)'),
        ),
        e('div', { style: S.row },
          e('button', { type: 'button', style: S.btn, disabled: checking, onClick: function () { void save() } },
            checking ? '检查中…' : '保存设置'),
          e('button', { type: 'button', style: S.btn, onClick: function () { void reload() } }, '刷新'),
          message !== null ? e('span', { style: message.kind === 'ok' ? S.ok : S.err }, message.text) : null,
        ),
        e('div', { style: S.panel },
          e('span', { style: S.title }, '实时状态'),
          poll !== null
            ? [
                poll.enabled
                  ? e('span', { key: 'enabled', style: S.dim },
                      '轮询中 · 每 ' + Math.round(poll.intervalMs / 1000) + ' 秒 · 仅处理 '
                      + String(poll.triggersOnlyIssuesCreatedAfter).slice(0, 19).replace('T', ' ') + ' UTC 之后新建的 issue')
                  : e('span', { key: 'disabled', style: S.dim }, '轮询未启用(仓库列表为空)'),
                poll.repos.map(function (row) {
                  return e('span', { key: row.repo, style: S.mono },
                    row.repo, '  ->  ', row.workspace ?? '-',
                    row.listedOnce ? ' · polled ' + (row.lastPollAt > 0 ? new Date(row.lastPollAt).toLocaleTimeString() : '-') : ' · listing…',
                    row.newestOpen !== undefined ? ' · open(近30) ' + row.newestOpen : '',
                    row.lastError ? e('span', { style: errLine }, ' · ' + String(row.lastError)) : null,
                  )
                }),
                e('span', { key: 'running', style: S.dim }, '运行中的处理:' + (status ? status.running : 0)),
              ]
            : e('span', { style: S.dim }, '填写访问 Token 后自动加载'),
          historyRows.length > 0
            ? e('div', { style: Object.assign({}, S.panel, { background: 'transparent', padding: '6px 0 0' }) },
                historyRows.map(function (entry) {
                  return e('span', { key: entry.repo + '#' + entry.number + ':' + entry.startedAt, style: S.mono },
                    '#' + entry.number + ' ' + String(entry.title).slice(0, 48),
                    ' · ', entry.state, ' · ', entry.source ?? 'webhook',
                    entry.state === 'error' && entry.error ? e('span', { style: errLine }, ' · ' + String(entry.error)) : null,
                  )
                }),
              )
            : null,
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'issue-bot', order: 90, label: 'Issue 监听' },
          IssueBotSettings,
        )
      })
    }

    const inject = ['slots']
    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    module.exports.name = 'issue-bot-client'
    return module.exports
  },
})
