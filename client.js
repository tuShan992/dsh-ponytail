/**
 * dsh-ponytail — client half (web settings page).
 *
 * Adds a "Ponytail" page to the settings/integrations panel with one button
 * that syncs the bundled skills from the latest upstream @dietrichgebert/ponytail
 * release and reinstalls the plugin into the profile. The work runs in the host
 * (server half: index.js routes /dsh-ponytail/status and /dsh-ponytail/sync).
 */
window.__ModuleLoader__.load({
  id: 'dsh-ponytail',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const STATUS_ROUTE = '/dsh-ponytail/status'
    const SYNC_ROUTE = '/dsh-ponytail/sync'

    const styles = {
      panel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-primary)',
      },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      label: { flex: 1, color: 'var(--dsw-alias-label-secondary)' },
      dim: { opacity: 0.65, fontSize: 12 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      },
      button: {
        minHeight: 32,
        padding: '0 13px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 16,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
      },
      buttonPrimary: {
        minHeight: 32,
        padding: '0 15px',
        border: '1px solid var(--dsw-alias-label-primary)',
        borderRadius: 16,
        background: 'var(--dsw-alias-label-primary)',
        color: 'var(--dsw-alias-bg-base, #fff)',
        cursor: 'pointer',
        font: 'inherit',
        fontWeight: 600,
      },
      log: {
        margin: 0,
        padding: '8px 10px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,0.08))',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 240,
        overflow: 'auto',
      },
      ok: { color: 'var(--dsw-state-success-primary)', fontSize: 12 },
      update: { color: 'var(--dsw-state-warning-primary, #c47f00)', fontSize: 12, whiteSpace: 'pre-wrap' },
      error: { color: 'var(--dsw-state-error-primary)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
    }

    // Remember the last sync result across component remounts (the settings
    // page re-renders when the plugin files on disk change) and reloads, so the
    // success hint and log don't vanish the instant the sync finishes.
    let lastResult = null
    let lastError = ''
    try {
      lastResult = JSON.parse(sessionStorage.getItem('dsh-ponytail.lastResult') || 'null')
      // Errors are transient: never restore a stale one from a previous version.
      sessionStorage.removeItem('dsh-ponytail.lastError')
    } catch {
      /* storage unavailable */
    }

    // Auto-check preference lives in localStorage; default is on.
    const readAutoCheck = () => {
      try { return localStorage.getItem('dsh-ponytail.autoCheck') !== '0' } catch { return true }
    }

    // Shared update state for the settings page and the nav icon. The background
    // poller below keeps it fresh even when the settings panel is closed.
    const remote = { updateAvailable: false, latestVersion: null }
    const remoteListeners = new Set()
    const subscribeRemote = (listener) => {
      remoteListeners.add(listener)
      return () => remoteListeners.delete(listener)
    }
    const setRemote = (patch) => {
      let changed = false
      for (const key of Object.keys(patch)) {
        if (remote[key] !== patch[key]) { remote[key] = patch[key]; changed = true }
      }
      if (changed) remoteListeners.forEach((listener) => { try { listener() } catch { /* ignore */ } })
    }
    const remoteFromStatus = (s) => setRemote({
      updateAvailable: !!(s && s.updateAvailable),
      latestVersion: (s && s.latestVersion) || null,
    })

    const spinnerIcon = () =>
      h('svg', {
        width: 14, height: 14, viewBox: '0 0 50 50',
        style: { verticalAlign: 'middle', marginRight: 6 },
      },
        h('circle', {
          cx: 25, cy: 25, r: 20, fill: 'none',
          stroke: 'currentColor', strokeWidth: 5, strokeDasharray: '90 150', strokeLinecap: 'round',
        },
          h('animateTransform', {
            attributeName: 'transform', type: 'rotate', from: '0 25 25', to: '360 25 25',
            dur: '0.8s', repeatCount: 'indefinite',
          }),
        ),
      )

    const gearSvg = (size) => h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      h('circle', { cx: 12, cy: 12, r: 3 }),
      h('path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7.1 7.1M16.9 16.9 19.1 19.1M4.9 19.1 7.1 16.9M16.9 7.1 19.1 4.9' }),
    )

    const checkSvg = (size) => h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'var(--dsw-state-success-primary)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    }, h('path', { d: 'M20 6 9 17l-5-5' }))

    // Subscribe to the shared update store; falls back to useState+useEffect on
    // older React builds that lack useSyncExternalStore.
    const useRemote = (selector, fallback) => {
      if (typeof React.useSyncExternalStore === 'function') {
        return React.useSyncExternalStore(subscribeRemote, selector, fallback)
      }
      const [value, setValue] = React.useState(selector)
      React.useEffect(() => subscribeRemote(() => setValue(selector())), [])
      return value
    }

    const dotSvg = () => h('span', {
      style: {
        position: 'absolute', top: -1, right: -1, width: 7, height: 7, borderRadius: '50%',
        background: 'var(--dsw-state-error-primary, #e5484d)',
        boxShadow: '0 0 0 1.5px var(--dsw-alias-bg-base, #fff)',
      },
    })

    // Nav icon for the Ponytail entry: a small gear that gains a red dot while
    // the background poller has found a newer upstream release.
    function UpdateIcon(props) {
      const updateAvailable = useRemote(() => remote.updateAvailable, () => false)
      const size = (props && props.size) || 16
      return h('span', { style: { position: 'relative', display: 'inline-flex', width: size, height: size } },
        gearSvg(size),
        updateAvailable ? dotSvg() : null,
      )
    }

    // Action beside Settings in the sidebar foot: appears only when a newer
    // upstream release is known (or while syncing), so the notice is visible
    // without opening Settings. Clicking it runs the same sync as the page.
    function SidebarUpdateAction() {
      const updateAvailable = useRemote(() => remote.updateAvailable, () => false)
      const latestVersion = useRemote(() => remote.latestVersion, () => null)
      const [busy, setBusy] = React.useState(false)
      const [done, setDone] = React.useState(false)
      if (!updateAvailable && !busy && !done) return null
      const onClick = () => {
        if (busy || done) return
        setBusy(true)
        fetch(SYNC_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(async (r) => {
            const body = await r.json().catch(() => null)
            if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`)
            return body
          })
          .then((body) => {
            setDone(true)
            setRemote({ updateAvailable: false })
            try { sessionStorage.setItem('dsh-ponytail.lastResult', JSON.stringify(body)) } catch { /* ignore */ }
          })
          .catch(() => { /* keep the dot so the user can retry */ })
          .finally(() => setBusy(false))
      }
      const title = busy
        ? '正在同步 Ponytail…'
        : done
          ? 'Ponytail 已同步，请重启 DSH'
          : `Ponytail 有新版本${latestVersion ? ` ${latestVersion}` : ''}，点击同步`
      return h('button', {
        type: 'button', title, 'aria-label': title, onClick,
        style: {
          width: 28, height: 28, padding: 0, border: 'none', borderRadius: 6, background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)', cursor: busy || done ? 'default' : 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
        },
      },
        busy ? spinnerIcon() : done ? checkSvg(16) : gearSvg(16),
        updateAvailable && !busy && !done ? dotSvg() : null,
      )
    }

    function Section() {
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const [autoCheck, setAutoCheckState] = React.useState(readAutoCheck)
      const [result, setResultState] = React.useState(lastResult)
      const [error, setErrorState] = React.useState(lastError)
      const setResult = (value) => {
        lastResult = value
        try { sessionStorage.setItem('dsh-ponytail.lastResult', JSON.stringify(value)) } catch { /* ignore */ }
        setResultState(value)
      }
      const setError = (value) => {
        lastError = value
        setErrorState(value)
      }

      // Silent by default: only the manual Refresh button passes showSpinner,
      // so merely opening the page does not make the button look busy.
      const loadStatus = (withLatest = true, showSpinner = false) => {
        if (showSpinner) setRefreshing(true)
        const startedAt = Date.now()
        fetch(STATUS_ROUTE, { cache: 'no-store', headers: withLatest ? {} : { 'x-ponytail-latest': '0' } })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((s) => { setStatus(s); setError(''); remoteFromStatus(s) })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => {
            if (!showSpinner) return
            // Keep the loading label on screen for a beat so the refresh is visible.
            const remaining = Math.max(0, 600 - (Date.now() - startedAt))
            setTimeout(() => setRefreshing(false), remaining)
          })
      }

      const setAutoCheck = (value) => {
        try { localStorage.setItem('dsh-ponytail.autoCheck', value ? '1' : '0') } catch { /* ignore */ }
        setAutoCheckState(value)
        if (value) loadStatus(true)
      }

      React.useEffect(() => { loadStatus(autoCheck) }, [])

      // When auto-check is on, poll the registry while the panel stays open.
      React.useEffect(() => {
        if (!autoCheck) return undefined
        const timer = setInterval(() => loadStatus(true), 10 * 60 * 1000)
        return () => clearInterval(timer)
      }, [autoCheck])

      const runSync = () => {
        setBusy(true)
        setError('')
        setResult(null)
        fetch(SYNC_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(async (response) => {
            const body = await response.json().catch(() => null)
            if (body) setResult(body)
            if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`)
            return body
          })
          .then((body) => {
            if (body && body.ok) loadStatus(true)
          })
          .catch((e) => setError(String((e && e.message) || e)))
          .finally(() => setBusy(false))
      }

      const ver = (value) => (value === null || value === undefined ? '—' : String(value))
      const steps = result && Array.isArray(result.steps) ? result.steps : []
      const canSync = Boolean(status && status.canSync)

      return h(
        'div',
        { style: styles.panel },
        h('div', { style: styles.dim },
          '把插件自带的技能同步到上游 @dietrichgebert/ponytail 的最新版本，并重装到当前 profile。Sync the bundled skills from the latest upstream release, then reinstall.'),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '上游版本 / Upstream'),
            h('span', { style: styles.mono }, ver(status && status.upstreamVersion))),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '已安装版本 / Installed'),
            h('span', { style: styles.mono }, ver(status && status.installedVersion))),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '最新上游 / Latest'),
            h('span', { style: styles.mono }, ver(status && status.latestVersion))),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '安装来源 / Spec'),
            h('span', { style: styles.mono }, ver(status && status.installedSpec))),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '源目录 / Source'),
            h('span', { style: styles.mono }, ver(status && status.sourceDir))),
          h('div', { style: styles.row },
            h('span', { style: styles.label }, '运行时 / Runtime'),
            h('span', { style: styles.mono }, `${ver(status && status.node)} · ${status && status.pnpm ? 'pnpm ✓' : 'pnpm ✗'}`)),
        ),
        h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: autoCheck, onChange: (e) => setAutoCheck(e.target.checked) }),
          '自动检测上游新版本（默认开启） / Auto-check for upstream updates'),
        h(
          'div',
          { style: styles.row },
          h('button', {
            style: busy || !canSync ? styles.button : styles.buttonPrimary,
            disabled: busy || !canSync,
            onClick: busy || !canSync ? undefined : runSync,
          }, busy ? h('span', null, spinnerIcon(), '同步中… Syncing…') : (canSync ? '同步上游并重装 / Sync upstream & reinstall' : '仅本地源码安装可同步 / Local install only')),
          h('button', {
            style: styles.button,
            disabled: busy || refreshing,
            onClick: busy || refreshing ? undefined : () => loadStatus(true, true),
          }, refreshing ? h('span', null, spinnerIcon(), '刷新中… Refreshing…') : '刷新 / Refresh'),
        ),
        status && status.updateAvailable
          ? h('div', { style: styles.update },
              canSync
                ? `⬆ 发现新版本 ${status.latestVersion}（已安装 ${status.installedVersion}）— 点「同步上游并重装」更新。`
                : `⬆ 发现新版本 ${status.latestVersion}（已安装 ${status.installedVersion}）— 此插件从 git/npm 安装，请用 pnpm 重新安装更新。`)
          : null,
        !canSync && status
          ? h('div', { style: styles.dim }, '当前为 git/npm 安装，没有本地源码目录；更新请在该 profile 里重新安装该插件。')
          : null,
        result && result.ok
          ? h('div', { style: styles.ok }, '✓ 同步完成。请重启 DSH 以加载更新后的技能与规则。Done — restart DSH to load the updated skills and rules.')
          : null,
        error !== '' ? h('div', { style: styles.error }, error) : null,
        result && result.ok === false && result.error
          ? h('div', { style: styles.error }, String(result.error))
          : null,
        steps.length
          ? h('pre', { style: styles.log }, steps
              .map((s) => `$ ${s.name} (exit ${s.code})\n${s.output || ''}`.trim())
              .join('\n\n'))
          : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'dsh-ponytail',
        order: 161,
        label: () => 'Ponytail',
      }, Section))
      slots.inject('settings.section.icon', () => slots.register({
        name: 'settings.section.icon',
        id: 'dsh-ponytail',
        order: 161,
        label: 'Ponytail',
      }, UpdateIcon))
      slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-ponytail',
        order: 161,
        label: 'Ponytail',
      }, SidebarUpdateAction))

      // Background update check: runs whenever the web client loads, without
      // opening the settings panel. Respects the auto-check preference.
      const checkForUpdates = () => {
        if (!readAutoCheck()) return
        fetch(STATUS_ROUTE, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((s) => remoteFromStatus(s))
          .catch(() => { /* offline or registry down: keep the last state */ })
      }
      setTimeout(checkForUpdates, 3000)
      setInterval(checkForUpdates, 10 * 60 * 1000)
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
