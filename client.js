/**
 * Browser half of dsh-cannbot-connect.
 *
 * The Host keeps the CANNBOT adapter and its live catalog; this module only
 * presents the settings that already exist in the Host Config and reads one
 * secret-free status document. Settings writes go through `ctx.configForms`,
 * the same revisioned path the built-in Models page uses, so no custom write
 * route or second HTTP surface is introduced.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cannbot-connect',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } = React

    const NS = 'cannbot-connect'
    const SETTINGS_NS = 'llm-cannbot'
    const SETTINGS_NS_FALLBACK = 'include:llm-cannbot'
    const STATUS_PATH = '/cannbot-connect/status'

    const MESSAGES = {
      zh: {
        nav: 'CANNBOT',
        title: 'CANNBOT 连接',
        intro: '复用 CANNWork 登录的 CANNBOT 网关；这里的修改会立即写入 DSH 设置。',
        'footer.title': 'CANNBOT',
        'footer.hint': '由 dsh-cannbot-connect 管理；在设置 → CANNBOT 中可完整配置。',
        'footer.expand': '展开配置',
        'status.loading': '正在读取状态…',
        'status.unavailable': '状态接口不可用',
        'status.desktop': 'Desktop 或未挂载 Web 服务时只提供配置编辑；凭据与目录状态需要在 Web GUI 查看。',
        'status.ready': '已连接',
        'status.inactive': '未激活',
        'status.configError': '配置未生效',
        'section.credentials': '账号与凭据',
        'section.credentialsHint': '凭据由 CANNWork 写入，插件只读取，不在浏览器中保存。',
        'section.models': '模型目录',
        'section.image': '图片',
        'section.advanced': '刷新与容量',
        'section.connection': '连接',
        'jwt': '访问令牌（JWT）',
        'vk': '虚拟密钥（VK）',
        'present': '已就绪',
        'missing': '缺失',
        'expired': '已过期',
        'unknownExpiry': '有效期未知',
        'source': '来源',
        'recheck': '重新检查',
        'refresh': '刷新模型目录',
        'refreshing': '正在刷新…',
        'lastRefresh': '最近刷新',
        'never': '尚未刷新',
        'failure.auth': 'CANNWork 登录已失效，请重新登录',
        'failure.network': '模型目录端点不可达',
        'failure.server': '模型目录端点拒绝了请求',
        'failure.unknown': '模型目录刷新失败',
        'modelCount': '模型数量',
        'modelSearch': '搜索模型',
        'modelId': '模型 ID',
        'modelName': '显示名',
        'context': '上下文',
        'maxTokens': '输出上限',
        'image': '图片',
        'noModels': '当前目录没有模型。',
        'noMatch': '没有匹配的模型。',
        'visionExtra': '不在当前目录、但仍保留在图片列表中的模型',
        'visionHint': '只对实测能读图的模型开放图片。未列出的模型按纯文本处理。',
        'visionFallback': '图片模型 id（逗号分隔）',
        'visionFallbackHint': '状态接口不可用时，仍可在这里维护图片模型列表。',
        'save': '保存更改',
        'saving': '正在保存…',
        'saved': '已保存',
        'saveFailed': '保存失败，请重试',
        'conflict': '保存失败：配置已在其他窗口修改，请重试',
        'noChanges': '没有需要保存的更改',
        'reset': '恢复默认',
        'resetField': '恢复 {field} 的默认值',
        'statusUnavailable': '状态不可用',
        'readOnly': '当前配置只读。',
        'version': '版本',
        'docs': '文档',
        'field.catalogRefreshMs': '目录刷新间隔（毫秒）',
        'field.streamIdleTimeoutMs': '上游空闲超时（毫秒）',
        'field.defaultContextWindow': '默认上下文窗口',
        'field.defaultMaxTokens': '默认输出上限',
        'field.requestImagePixelBudget': '单图像素预算',
        'field.requestImageMaxBytes': '单图编码字节上限',
        'field.maxRequestImageBytes': '单请求图片总字节',
        'field.maxRequestImages': '单请求图片数量',
        'field.imageOffloadCountQuantum': '超限降级步长',
        'hint.catalogRefreshMs': '0 表示关闭定时刷新；仍可手动刷新。',
        'hint.streamIdleTimeoutMs': '一次上游读取允许的最长空闲时间。',
        'hint.requestImagePixelBudget': '等比缩放后的像素上限，不会放大图片。',
        'hint.requestImageMaxBytes': '单张图片编码后的字节目标。',
        'hint.maxRequestImageBytes': '累计 base64 图片超出时，DSH 会把最旧图片替换为占位文本。',
        'hint.maxRequestImages': '网关未公布数量限制；字节预算才是当前实际约束。',
        'hint.imageOffloadCountQuantum': '计数超限时一次移除的图片数，不得大于数量上限。',
        'invalid.number': '请输入正整数',
        'invalid.range': '数值超出允许范围',
        'invalid.quantum': '降级步长不能大于图片数量上限',
        'invalid.budget': '单图字节上限不能大于请求总字节上限',
        'connection.readOnly': '端点由部署配置决定；这里只读展示。',
        'connection.baseURL': '网关端点',
        'connection.modelsURL': '模型目录端点',
        'config.loading': '正在加载配置…',
        'config.unavailable': '当前宿主没有提供可编辑的 CANNBOT 配置。',
        'config.blocked': '配置尚未加载，可能还在启动中。',
        'saveConflictHint': '若冲突持续，请刷新页面后重试。',
        'openCannwork': '打开 CANNWork 并重新登录后，点击“重新检查”。',
        'credential.missing': '未找到凭据。请先在 CANNWork 中登录。',
        'credential.expired': '凭据已过期。请重新登录 CANNWork。',
        'credential.vkMissing': '未找到虚拟密钥（VK）。请先在 CANNWork 中登录。',
        'modelsFooter': 'CANNBOT 设置',
      },
      en: {
        nav: 'CANNBOT',
        title: 'CANNBOT connection',
        intro: 'The CANNBOT gateway through your existing CANNWork sign-in. Changes here are written to DSH settings immediately.',
        'footer.title': 'CANNBOT',
        'footer.hint': 'Managed by dsh-cannbot-connect. Open Settings → CANNBOT for the full editor.',
        'footer.expand': 'Open settings',
        'status.loading': 'Reading status…',
        'status.unavailable': 'Status unavailable',
        'status.desktop': 'Desktop or a host without the Web server exposes configuration only; credentials and catalog status require the Web GUI.',
        'status.ready': 'Connected',
        'status.inactive': 'Inactive',
        'status.configError': 'Configuration not applied',
        'section.credentials': 'Account and credentials',
        'section.credentialsHint': 'CANNWork writes the credentials; the plugin only reads them and never stores them in the browser.',
        'section.models': 'Model catalog',
        'section.image': 'Images',
        'section.advanced': 'Refresh and capacity',
        'section.connection': 'Connection',
        'jwt': 'Access token (JWT)',
        'vk': 'Virtual key (VK)',
        'present': 'Ready',
        'missing': 'Missing',
        'expired': 'Expired',
        'unknownExpiry': 'Expiry unknown',
        'source': 'Source',
        'recheck': 'Check again',
        'refresh': 'Refresh models',
        'refreshing': 'Refreshing…',
        'lastRefresh': 'Last refresh',
        'never': 'Never',
        'failure.auth': 'CANNWork sign-in expired; sign in again',
        'failure.network': 'Model catalog endpoint unreachable',
        'failure.server': 'Model catalog endpoint rejected the request',
        'failure.unknown': 'Model catalog refresh failed',
        'modelCount': 'Models',
        'modelSearch': 'Search models',
        'modelId': 'Model ID',
        'modelName': 'Display name',
        'context': 'Context',
        'maxTokens': 'Max output',
        'image': 'Image',
        'noModels': 'The current catalog is empty.',
        'noMatch': 'No matching models.',
        'visionExtra': 'Models kept in the image list even though the current catalog does not offer them',
        'visionHint': 'Images are enabled only for measured models. Unlisted models are treated as text-only.',
        'visionFallback': 'Image model ids (comma separated)',
        'visionFallbackHint': 'When the status endpoint is unavailable, maintain the image list here.',
        'save': 'Save changes',
        'saving': 'Saving…',
        'saved': 'Saved',
        'saveFailed': 'Save failed; try again',
        'conflict': 'Save failed: the configuration changed in another window; try again',
        'noChanges': 'No changes to save',
        'reset': 'Restore default',
        'resetField': 'Restore the default for {field}',
        'statusUnavailable': 'Status unavailable',
        'readOnly': 'This configuration is read-only.',
        'version': 'Version',
        'docs': 'Documentation',
        'field.catalogRefreshMs': 'Catalog refresh interval (ms)',
        'field.streamIdleTimeoutMs': 'Upstream idle timeout (ms)',
        'field.defaultContextWindow': 'Default context window',
        'field.defaultMaxTokens': 'Default max output',
        'field.requestImagePixelBudget': 'Per-image pixel budget',
        'field.requestImageMaxBytes': 'Per-image encoded byte cap',
        'field.maxRequestImageBytes': 'Request image byte budget',
        'field.maxRequestImages': 'Request image count',
        'field.imageOffloadCountQuantum': 'Overflow offload step',
        'hint.catalogRefreshMs': '0 disables the timer; manual refresh still works.',
        'hint.streamIdleTimeoutMs': 'Longest idle time allowed for one upstream read.',
        'hint.requestImagePixelBudget': 'Pixel cap after proportional scaling; images are never enlarged.',
        'hint.requestImageMaxBytes': 'Encoded-byte target for one image.',
        'hint.maxRequestImageBytes': 'When accumulated base64 images exceed this, DSH replaces the oldest images with placeholders.',
        'hint.maxRequestImages': 'The gateway publishes no count limit; the byte budget is the operative cap.',
        'hint.imageOffloadCountQuantum': 'Images removed per count overflow; must not exceed the count bound.',
        'invalid.number': 'Enter a positive integer',
        'invalid.range': 'Value is outside the allowed range',
        'invalid.quantum': 'The offload step cannot exceed the image count bound',
        'invalid.budget': 'The per-image cap cannot exceed the request byte budget',
        'connection.readOnly': 'Endpoints are deployment configuration and are shown read-only here.',
        'connection.baseURL': 'Gateway endpoint',
        'connection.modelsURL': 'Catalog endpoint',
        'config.loading': 'Loading configuration…',
        'config.unavailable': 'This host does not expose an editable CANNBOT configuration.',
        'config.blocked': 'Configuration is not loaded yet; the host may still be starting.',
        'saveConflictHint': 'If the conflict persists, refresh the page and try again.',
        'openCannwork': 'Open CANNWork, sign in again, then choose “Check again”.',
        'credential.missing': 'No credential found. Sign in through CANNWork first.',
        'credential.expired': 'The credential expired. Sign in through CANNWork again.',
        'credential.vkMissing': 'No virtual key (VK) found. Sign in through CANNWork first.',
        'modelsFooter': 'CANNBOT settings',
      },
    }

    const NUMBER_FIELDS = [
      { key: 'catalogRefreshMs', min: 0, max: 604_800_000, section: 'advanced' },
      { key: 'streamIdleTimeoutMs', min: 1_000, max: 86_400_000, section: 'advanced' },
      { key: 'defaultContextWindow', min: 1, section: 'advanced' },
      { key: 'defaultMaxTokens', min: 1, section: 'advanced' },
      { key: 'requestImagePixelBudget', min: 1, section: 'image' },
      { key: 'requestImageMaxBytes', min: 1, section: 'image' },
      { key: 'maxRequestImageBytes', min: 1, section: 'image' },
      { key: 'maxRequestImages', min: 1, section: 'image' },
      { key: 'imageOffloadCountQuantum', min: 1, section: 'image' },
    ]

    const CSS = `
      .cannbot-page { display:flex; flex-direction:column; gap:16px; max-width:980px; padding:4px 0 28px; color:var(--dsw-alias-label-primary); }
      .cannbot-page * { box-sizing:border-box; }
      .cannbot-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; }
      .cannbot-title { margin:0; font-size:18px; line-height:1.4; font-weight:600; }
      .cannbot-intro { margin:6px 0 0; color:var(--dsw-alias-label-secondary); font-size:13px; line-height:1.6; max-width:680px; }
      .cannbot-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .cannbot-card { border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-settings-card-fill); padding:16px; }
      .cannbot-cardHead { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
      .cannbot-cardTitle { margin:0; font-size:14px; font-weight:600; }
      .cannbot-cardHint { margin:4px 0 0; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; }
      .cannbot-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; }
      .cannbot-field { display:flex; flex-direction:column; gap:6px; min-width:0; }
      .cannbot-label { font-size:12px; color:var(--dsw-alias-label-secondary); }
      .cannbot-input { width:100%; border:1px solid var(--dsw-alias-border-l3); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); padding:7px 9px; font:inherit; font-size:13px; }
      .cannbot-input:focus-visible, .cannbot-button:focus-visible, .cannbot-summary:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
      .cannbot-input[aria-invalid="true"] { border-color:var(--dsw-alias-state-error-primary); }
      .cannbot-hint { color:var(--dsw-alias-label-tertiary); font-size:11px; line-height:1.45; }
      .cannbot-error { color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:1.45; }
      .cannbot-button { border:1px solid var(--dsw-alias-border-l3); border-radius:8px; background:var(--dsw-alias-button-primary-fill); color:var(--dsw-alias-label-primary-foreground); padding:7px 12px; font:inherit; font-size:12px; cursor:pointer; }
      .cannbot-button:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover); }
      .cannbot-button:disabled { opacity:.55; cursor:not-allowed; }
      .cannbot-button.secondary { background:transparent; color:var(--dsw-alias-label-primary); }
      .cannbot-button.secondary:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
      .cannbot-button.quiet { background:transparent; border-color:transparent; color:var(--dsw-alias-label-secondary); padding:3px 6px; }
      .cannbot-button.quiet:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
      .cannbot-badge { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:3px 9px; font-size:12px; border:1px solid var(--dsw-alias-border-l3); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
      .cannbot-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-label-tertiary); display:inline-block; }
      .cannbot-dot.ok { background:var(--dsw-alias-state-success-primary); }
      .cannbot-dot.warn { background:var(--dsw-alias-state-warn-label); }
      .cannbot-dot.error { background:var(--dsw-alias-state-error-primary); }
      .cannbot-notice { border-radius:8px; padding:8px 10px; font-size:12px; border:1px solid var(--dsw-alias-border-l2); }
      .cannbot-notice.ok { color:var(--dsw-alias-state-success-primary); }
      .cannbot-notice.error { color:var(--dsw-alias-state-error-primary); }
      .cannbot-notice.info { color:var(--dsw-alias-label-secondary); }
      .cannbot-tableWrap { overflow-x:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; }
      .cannbot-table { width:100%; border-collapse:collapse; font-size:12px; min-width:560px; }
      .cannbot-table th, .cannbot-table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--dsw-alias-border-l2); vertical-align:middle; }
      .cannbot-table th { color:var(--dsw-alias-label-secondary); font-weight:500; background:var(--dsw-alias-bg-module-platform); }
      .cannbot-table tr:last-child td { border-bottom:0; }
      .cannbot-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; }
      .cannbot-check { width:16px; height:16px; accent-color:var(--dsw-alias-state-business-primary); }
      .cannbot-inline { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .cannbot-tags { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
      .cannbot-tag { border:1px solid var(--dsw-alias-border-l2); border-radius:999px; padding:2px 8px; font-size:11px; color:var(--dsw-alias-label-secondary); }
      .cannbot-footer { border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-settings-card-fill); margin-top:12px; }
      .cannbot-summary { list-style:none; cursor:pointer; padding:12px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .cannbot-summary::-webkit-details-marker { display:none; }
      .cannbot-summaryText { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:13px; }
      .cannbot-footerBody { display:flex; flex-direction:column; gap:16px; border-top:1px solid var(--dsw-alias-border-l2); padding:16px; }
      .cannbot-footerBody * { box-sizing:border-box; }
      @media (max-width: 640px) {
        .cannbot-card { padding:12px; }
        .cannbot-header { align-items:stretch; }
        .cannbot-actions { width:100%; }
        .cannbot-button { min-height:36px; }
      }
    `

    /** One namespace's live form snapshot. */
    function useForm(form) {
      return useSyncExternalStore(
        (listener) => form.subscribe(listener),
        () => form.getSnapshot(),
      )
    }

    /** Read the Host status document; unavailable is a normal posture, not an error UI. */
    function useStatus() {
      const [state, setState] = useState({ kind: 'loading' })
      const load = useCallback(async (signal) => {
        try {
          const response = await fetch(STATUS_PATH, {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
            cache: 'no-store',
            ...(signal === undefined ? {} : { signal }),
          })
          if (!response.ok) throw new Error(`status ${response.status}`)
          const data = await response.json()
          setState({ kind: 'ready', data })
        } catch (error) {
          if (error?.name === 'AbortError') return
          setState({ kind: 'unavailable' })
        }
      }, [])
      useEffect(() => {
        const controller = new AbortController()
        void load(controller.signal)
        return () => controller.abort()
      }, [load])
      return [state, load]
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      try {
        return new Date(value).toLocaleString()
      } catch {
        return undefined
      }
    }

    function numberError(field, raw, t) {
      if (raw === '') return undefined
      const value = Number(raw)
      if (!Number.isInteger(value)) return t('invalid.number')
      if (value < field.min) return t('invalid.range')
      if (field.max !== undefined && value > field.max) return t('invalid.range')
      return undefined
    }

    function dotClass(state) {
      if (state === 'ok') return 'cannbot-dot ok'
      if (state === 'warn') return 'cannbot-dot warn'
      if (state === 'error') return 'cannbot-dot error'
      return 'cannbot-dot'
    }

    function Badge({ text, state }) {
      return h('span', { className: 'cannbot-badge' },
        h('span', { className: dotClass(state), 'aria-hidden': true }),
        text)
    }

    function Notice({ notice }) {
      if (notice === undefined) return null
      return h('p', {
        className: `cannbot-notice ${notice.kind}`,
        role: notice.kind === 'error' ? 'alert' : 'status',
        'aria-live': notice.kind === 'error' ? 'assertive' : 'polite',
      }, notice.text)
    }

    function Card({ title, hint, children, actions }) {
      return h('section', { className: 'cannbot-card' },
        h('div', { className: 'cannbot-cardHead' },
          h('div', null,
            h('h3', { className: 'cannbot-cardTitle' }, title),
            hint === undefined ? null : h('p', { className: 'cannbot-cardHint' }, hint)),
          actions === undefined ? null : h('div', { className: 'cannbot-actions' }, actions)),
        children)
    }

    function CredentialRow({ label, credential, t }) {
      const present = credential?.present === true
      const expired = credential?.expired === true
      const state = present && !expired ? 'ok' : 'error'
      const text = !present ? t('missing') : expired ? t('expired') : t('present')
      const expires = formatTime(credential?.expiresAtMs)
      return h('div', { className: 'cannbot-field' },
        h('span', { className: 'cannbot-label' }, label),
        h('div', { className: 'cannbot-inline' },
          h(Badge, { text, state }),
          credential?.sourceLabel === undefined
            ? null
            : h('span', { className: 'cannbot-hint' }, `${t('source')}: ${credential.sourceLabel}`)),
        present && !expired && expires === undefined
          ? h('span', { className: 'cannbot-hint' }, t('unknownExpiry'))
          : expires === undefined ? null : h('span', { className: 'cannbot-hint' }, expires))
    }

    /**
     * The one editor, rendered full-page in Settings and folded into the
     * Models page footer. Both instances share the Host form, so a save in one
     * is visible to the other through the settings mirror.
     */
    function CannbotPanel(props) {
      const { form, getForm, t, mode = 'page' } = props
      const [status, reloadStatus] = useStatus()
      const statusData = status.kind === 'ready' ? status.data : undefined
      const activeForm = useMemo(
        () => getForm?.(statusData?.settingsNs) ?? form,
        [getForm, statusData?.settingsNs, form],
      )
      const snapshot = useForm(activeForm)
      const [drafts, setDrafts] = useState({})
      const [visionDraft, setVisionDraft] = useState(null)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState(undefined)
      const [search, setSearch] = useState('')
      const timers = useRef([])
      const idPrefix = useId()

      const value = snapshot.value ?? {}
      const user = snapshot.user ?? {}
      const writable = snapshot.writable === true
      useEffect(() => () => {
        for (const timer of timers.current) clearTimeout(timer)
        timers.current = []
      }, [])

      const modelRows = useMemo(() => {
        const rows = Array.isArray(statusData?.models) ? statusData.models : []
        const query = search.trim().toLowerCase()
        if (query === '') return rows
        return rows.filter((model) =>
          String(model.id).toLowerCase().includes(query)
          || String(model.name ?? '').toLowerCase().includes(query))
      }, [statusData, search])

      const modelIds = useMemo(() => new Set((statusData?.models ?? []).map((model) => model.id)), [statusData])
      const effectiveVision = Array.isArray(visionDraft)
        ? visionDraft
        : Array.isArray(value.visionModels) ? value.visionModels : []
      const visionSet = useMemo(() => new Set(effectiveVision), [effectiveVision])
      const extraVision = effectiveVision.filter((id) => !modelIds.has(id))

      const draftValue = (key) => drafts[key] ?? (value[key] === undefined ? '' : String(value[key]))
      const numericDirty = NUMBER_FIELDS.some((field) =>
        drafts[field.key] !== undefined
        && drafts[field.key] !== (value[field.key] === undefined ? '' : String(value[field.key])))
      const visionDirty = visionDraft !== null
        && JSON.stringify(visionDraft) !== JSON.stringify(Array.isArray(value.visionModels) ? value.visionModels : [])
      const dirty = numericDirty || visionDirty

      const showNotice = (kind, text) => {
        setNotice({ kind, text })
        for (const timer of timers.current) clearTimeout(timer)
        timers.current = []
        if (kind !== 'error') {
          timers.current.push(setTimeout(() => setNotice(undefined), 4000))
        }
      }

      const resetDrafts = () => {
        const next = {}
        for (const field of NUMBER_FIELDS) next[field.key] = value[field.key] === undefined ? '' : String(value[field.key])
        setDrafts(next)
        setVisionDraft(null)
      }

      const fieldNumber = (key) => {
        const raw = String(draftValue(key)).trim()
        return raw === '' ? Number(value[key]) : Number(raw)
      }

      const collectOps = () => {
        const ops = []
        for (const field of NUMBER_FIELDS) {
          const raw = String(draftValue(field.key)).trim()
          const error = numberError(field, raw, t)
          if (error !== undefined) return { error, field: field.key }
          if (raw === '') {
            if (user[field.key] !== undefined) ops.push({ op: 'unset', path: [field.key] })
            continue
          }
          const valueNumber = Number(raw)
          if (valueNumber !== value[field.key]) ops.push({ op: 'set', path: [field.key], value: valueNumber })
        }
        if (fieldNumber('imageOffloadCountQuantum') > fieldNumber('maxRequestImages')) {
          return { error: t('invalid.quantum'), field: 'imageOffloadCountQuantum' }
        }
        if (fieldNumber('requestImageMaxBytes') > fieldNumber('maxRequestImageBytes')) {
          return { error: t('invalid.budget'), field: 'requestImageMaxBytes' }
        }
        if (visionDirty) {
          ops.push({ op: 'set', path: ['visionModels'], value: [...(visionDraft ?? [])] })
        }
        return { ops }
      }

      const save = async () => {
        if (!writable || saving) return
        const collected = collectOps()
        if (collected.error !== undefined) {
          showNotice('error', collected.error)
          return
        }
        if (collected.ops.length === 0) {
          showNotice('info', t('noChanges'))
          return
        }
        setSaving(true)
        try {
          const accepted = await activeForm.mutate(collected.ops)
          if (!accepted) {
            showNotice('error', `${t('conflict')} ${t('saveConflictHint')}`)
            return
          }
          setVisionDraft(null)
          setDrafts((current) => {
            const next = { ...current }
            for (const op of collected.ops) delete next[op.path[0]]
            return next
          })
          showNotice('ok', t('saved'))
          void reloadStatus()
        } catch {
          showNotice('error', t('saveFailed'))
        } finally {
          setSaving(false)
        }
      }

      const resetField = async (key) => {
        if (!writable || saving) return
        try {
          const accepted = await activeForm.unset(key)
          if (!accepted) {
            showNotice('error', t('conflict'))
            return
          }
          setDrafts((current) => {
            const next = { ...current }
            delete next[key]
            return next
          })
          showNotice('ok', t('saved'))
        } catch {
          showNotice('error', t('saveFailed'))
        }
      }

      const resetVision = async () => {
        if (!writable || saving) return
        try {
          const accepted = await activeForm.unset('visionModels')
          if (!accepted) {
            showNotice('error', t('conflict'))
            return
          }
          setVisionDraft(null)
          showNotice('ok', t('saved'))
        } catch {
          showNotice('error', t('saveFailed'))
        }
      }

      const refreshModels = async () => {
        if (!writable || saving) return
        setSaving(true)
        try {
          const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
          const accepted = await activeForm.set('refreshNonce', nonce)
          if (!accepted) {
            showNotice('error', t('conflict'))
            return
          }
          showNotice('info', t('refreshing'))
          timers.current.push(setTimeout(() => { void reloadStatus() }, 1000))
          timers.current.push(setTimeout(() => { void reloadStatus() }, 3000))
        } catch {
          showNotice('error', t('saveFailed'))
        } finally {
          setSaving(false)
        }
      }

      const toggleVision = (modelId, checked) => {
        const next = new Set(effectiveVision)
        if (checked) next.add(modelId)
        else next.delete(modelId)
        setVisionDraft([...next])
      }

      const updateVisionText = (text) => {
        const ids = text.split(',').map((id) => id.trim()).filter((id) => id !== '')
        setVisionDraft([...new Set(ids)])
      }

      if (snapshot.status === 'loading') {
        return h('p', { className: 'cannbot-hint' }, t('config.loading'))
      }
      if (snapshot.status === 'unavailable') {
        return h('p', { className: 'cannbot-error' }, t('config.unavailable'))
      }

      const statusBadge = status.kind === 'ready'
        ? h(Badge, { text: `${t('status.ready')} · ${statusData.modelCount ?? 0}`, state: 'ok' })
        : h(Badge, { text: t('statusUnavailable'), state: 'warn' })

      const jwtCredential = statusData?.credentials?.jwt
      const vkCredential = statusData?.credentials?.vk
      const credentialIssue = jwtCredential?.present !== true
        ? 'credential.missing'
        : jwtCredential?.expired === true
          ? 'credential.expired'
          : vkCredential?.present !== true
            ? 'credential.vkMissing'
            : undefined
      const credentialsCard = h(Card, {
        title: t('section.credentials'),
        hint: t('section.credentialsHint'),
        actions: status.kind === 'ready'
          ? h('button', {
            type: 'button',
            className: 'cannbot-button secondary',
            onClick: () => { void reloadStatus() },
          }, t('recheck'))
          : null,
      }, status.kind === 'ready'
        ? h('div', { className: 'cannbot-grid' },
          h(CredentialRow, { label: t('jwt'), credential: statusData.credentials?.jwt, t }),
          h(CredentialRow, { label: t('vk'), credential: statusData.credentials?.vk, t }),
          credentialIssue === undefined
            ? null
            : h('p', { className: 'cannbot-error' }, t(credentialIssue), ' ', t('openCannwork')))
        : h('div', null,
          h('p', { className: 'cannbot-hint' }, t('status.desktop')),
          h('p', { className: 'cannbot-hint' }, t('statusUnavailable'))))

      const modelsBody = status.kind !== 'ready'
        ? h('div', { className: 'cannbot-field' },
          h('label', { className: 'cannbot-label', htmlFor: `${idPrefix}-vision` }, t('visionFallback')),
          h('input', {
            id: `${idPrefix}-vision`,
            className: 'cannbot-input',
            type: 'text',
            value: effectiveVision.join(', '),
            disabled: !writable || saving,
            onChange: (event) => updateVisionText(event.target.value),
          }),
          h('span', { className: 'cannbot-hint' }, t('visionFallbackHint')))
        : h('div', null,
          statusData.catalog?.lastFailure === undefined
            ? null
            : h('p', { className: 'cannbot-error' },
              t(`failure.${statusData.catalog.lastFailure}`)),
          h('div', { className: 'cannbot-field' },
            h('label', { className: 'cannbot-label', htmlFor: `${idPrefix}-search` }, t('modelSearch')),
            h('input', {
              id: `${idPrefix}-search`,
              className: 'cannbot-input',
              type: 'search',
              value: search,
              onChange: (event) => setSearch(event.target.value),
            })),
          h('div', { className: 'cannbot-tableWrap' },
            h('table', { className: 'cannbot-table' },
              h('thead', null,
                h('tr', null,
                  h('th', { scope: 'col' }, t('image')),
                  h('th', { scope: 'col' }, t('modelId')),
                  h('th', { scope: 'col' }, t('modelName')),
                  h('th', { scope: 'col' }, t('context')),
                  h('th', { scope: 'col' }, t('maxTokens')))),
              h('tbody', null,
                modelRows.length === 0
                  ? h('tr', null,
                    h('td', { colSpan: 5, className: 'cannbot-hint' },
                      (statusData.models ?? []).length === 0 ? t('noModels') : t('noMatch')))
                  : modelRows.map((model) => h('tr', { key: model.id },
                    h('td', null,
                      h('input', {
                        className: 'cannbot-check',
                        type: 'checkbox',
                        checked: visionSet.has(model.id),
                        disabled: !writable || saving,
                        'aria-label': `${t('image')}: ${model.id}`,
                        onChange: (event) => toggleVision(model.id, event.target.checked),
                      })),
                    h('td', { className: 'cannbot-mono' }, model.id),
                    h('td', null, model.name ?? model.id),
                    h('td', null, model.contextWindow ?? '—'),
                    h('td', null, model.maxTokens ?? '—')))))),
          extraVision.length === 0
            ? null
            : h('div', { className: 'cannbot-tags' },
              h('span', { className: 'cannbot-hint' }, t('visionExtra')),
              ...extraVision.map((id) => h('span', { className: 'cannbot-tag cannbot-mono', key: id }, id))),
          h('p', { className: 'cannbot-hint' }, t('visionHint')))

      const modelsCard = h(Card, {
        title: t('section.models'),
        hint: status.kind === 'ready'
          ? `${t('modelCount')}: ${statusData.modelCount ?? 0} · ${t('lastRefresh')}: ${formatTime(statusData.catalog?.lastRefreshAt) ?? t('never')}`
          : t('status.desktop'),
        actions: h('button', {
          type: 'button',
          className: 'cannbot-button secondary',
          disabled: !writable || saving,
          onClick: () => { void refreshModels() },
        }, saving ? t('refreshing') : t('refresh')),
      }, modelsBody)

      const renderField = (field) => {
        const id = `${idPrefix}-${field.key}`
        const raw = draftValue(field.key)
        const error = numberError(field, String(raw).trim(), t)
        return h('div', { className: 'cannbot-field', key: field.key },
          h('label', { className: 'cannbot-label', htmlFor: id }, t(`field.${field.key}`)),
          h('input', {
            id,
            className: 'cannbot-input',
            type: 'number',
            inputMode: 'numeric',
            min: field.min,
            max: field.max,
            step: 1,
            value: raw,
            disabled: !writable || saving,
            'aria-invalid': error !== undefined,
            'aria-describedby': `${id}-hint`,
            onChange: (event) => {
              const next = event.target.value
              setDrafts((current) => ({ ...current, [field.key]: next }))
            },
          }),
          h('span', { id: `${id}-hint`, className: 'cannbot-hint' }, t(`hint.${field.key}`)),
          error === undefined ? null : h('span', { className: 'cannbot-error' }, error),
          user[field.key] === undefined
            ? null
            : h('button', {
              type: 'button',
              className: 'cannbot-button quiet',
              disabled: !writable || saving,
              'aria-label': t('resetField').replace('{field}', () => t(`field.${field.key}`)),
              onClick: () => { void resetField(field.key) },
            }, t('reset')))
      }

      const imageCard = h(Card, {
        title: t('section.image'),
        hint: t('visionHint'),
        actions: user.visionModels === undefined
          ? null
          : h('button', {
            type: 'button',
            className: 'cannbot-button quiet',
            disabled: !writable || saving,
            onClick: () => { void resetVision() },
          }, t('reset')),
      }, h('div', { className: 'cannbot-grid' },
        ...NUMBER_FIELDS.filter((field) => field.section === 'image').map(renderField)))

      const advancedCard = h(Card, {
        title: t('section.advanced'),
      }, h('div', { className: 'cannbot-grid' },
        ...NUMBER_FIELDS.filter((field) => field.section === 'advanced').map(renderField)))

      const connectionCard = h(Card, {
        title: t('section.connection'),
        hint: t('connection.readOnly'),
      }, h('div', { className: 'cannbot-grid' },
        h('div', { className: 'cannbot-field' },
          h('span', { className: 'cannbot-label' }, t('connection.baseURL')),
          h('span', { className: 'cannbot-mono' }, value.baseURL ?? '—')),
        h('div', { className: 'cannbot-field' },
          h('span', { className: 'cannbot-label' }, t('connection.modelsURL')),
          h('span', { className: 'cannbot-mono' }, value.modelsURL ?? '—'))))

      const header = h('header', { className: 'cannbot-header' },
        h('div', null,
          h('h2', { className: 'cannbot-title' }, t('title')),
          h('p', { className: 'cannbot-intro' }, t('intro'))),
        h('div', { className: 'cannbot-actions' },
          statusBadge,
          h('button', {
            type: 'button',
            className: 'cannbot-button',
            disabled: !writable || saving || !dirty,
            onClick: () => { void save() },
          }, saving ? t('saving') : t('save'))))

      const body = h('div', { className: mode === 'page' ? 'cannbot-page' : 'cannbot-footerBody' },
        h('style', null, CSS),
        header,
        h(Notice, { notice }),
        snapshot.writable !== true ? h('p', { className: 'cannbot-hint' }, t('readOnly')) : null,
        statusData?.configError === undefined
          ? null
          : h('p', { className: 'cannbot-error' }, `${t('status.configError')}: ${statusData.configError}`),
        credentialsCard,
        modelsCard,
        imageCard,
        advancedCard,
        connectionCard,
        h('p', { className: 'cannbot-hint' },
          `${t('version')}: ${statusData?.version ?? '—'} · ${t('docs')}: docs/CONFIGURATION.md`))

      if (mode === 'footer') {
        const count = status.kind === 'ready' ? statusData.modelCount ?? 0 : undefined
        return h('details', { className: 'cannbot-footer' },
          h('summary', { className: 'cannbot-summary' },
            h('span', { className: 'cannbot-summaryText' },
              h('span', { className: dotClass(status.kind === 'ready' ? 'ok' : 'warn'), 'aria-hidden': true }),
              h('strong', null, t('footer.title')),
              h('span', { className: 'cannbot-hint' }, count === undefined ? t('statusUnavailable') : `${t('modelCount')}: ${count}`),
              h('span', { className: 'cannbot-hint' }, t('footer.hint'))),
            h('span', { className: 'cannbot-hint' }, t('footer.expand'))),
          body)
      }
      return body
    }

    /**
     * Register the Settings page and the Models-page footer card. Both use the
     * same form and component; `ctx.slots.inject` is the capability probe, so
     * an older host without either slot simply shows nothing.
     */
    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, MESSAGES), 'cannbot-connect: settings copy')
        const t = ctx.locale.bind(NS)
        ctx.inject(['configForms'], (child) => {
          const getForm = (settingsNs) => {
            for (const ns of [settingsNs, SETTINGS_NS, SETTINGS_NS_FALLBACK]) {
              if (typeof ns !== 'string' || ns === '') continue
              const form = child.configForms.get(ns)
              if (form.getSnapshot().status !== 'unavailable') return form
            }
            return child.configForms.get(SETTINGS_NS)
          }
          const form = getForm()
          const register = (name, extra) => child.slots.inject(name, () => child.slots.register({
            name,
            id: NS,
            order: 30,
            locale: NS,
            inject: () => ({ form, getForm, t }),
            ...extra,
          }, CannbotPanel))
          child.effect(() => {
            const disposers = [
              register('settings.section', { label: () => t('nav') }),
              register('settings.models.footer', {}),
            ]
            return () => {
              for (const dispose of disposers) dispose?.()
            }
          })
        })
      } catch (error) {
        console.error(`[${NS}] settings page failed to register (provider unaffected):`, error)
      }
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
