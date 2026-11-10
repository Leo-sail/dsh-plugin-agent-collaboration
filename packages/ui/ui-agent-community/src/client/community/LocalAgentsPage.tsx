/**
 * 本机 Agent settings panel (A6).
 *
 * Lists the agent CLIs discovery found on this machine, the routes that were actually
 * registered as model providers, and the user's custom ACP agents. This is the A1 host
 * service's `LocalAgentSnapshot` rendered — adding/editing/removing a custom agent is the only
 * write surface; detection itself is read-only and refreshed on demand.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { css } from '../styles.ts'
import type { CommunityRemote, LocalAgentSnapshotView } from './types.ts'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function LocalAgentsPage({ remote }: { remote: CommunityRemote }) {
  const [snapshot, setSnapshot] = useState<LocalAgentSnapshotView | undefined>(undefined)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [editingId, setEditingId] = useState<string | undefined>(undefined)

  const apply = useCallback((value: LocalAgentSnapshotView) => {
    setSnapshot(value)
    setError('')
  }, [])

  const load = useCallback(async (action: () => Promise<LocalAgentSnapshotView>) => {
    setBusy(true)
    setError('')
    try {
      apply(await action())
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }, [apply])

  useEffect(() => {
    void load(() => remote.localAgentSnapshot())
  }, [load, remote])

  const resetForm = useCallback(() => {
    setName('')
    setCommand('')
    setArgs('')
    setEditingId(undefined)
  }, [])

  const submit = useCallback(async () => {
    const cleanName = name.trim()
    const cleanCommand = command.trim()
    if (cleanName === '' || cleanCommand === '') {
      setError('名称和命令不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      const payload = { name: cleanName, command: cleanCommand, args }
      const next = editingId === undefined
        ? await remote.localAgentAddCustomAgent(payload)
        : await remote.localAgentUpdateCustomAgent({ id: editingId, ...payload })
      apply(next)
      resetForm()
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }, [apply, args, command, editingId, name, remote, resetForm])

  const startEdit = useCallback((agent: LocalAgentSnapshotView['custom'][number]) => {
    setEditingId(agent.id)
    setName(agent.name)
    setCommand(agent.command)
    setArgs(agent.args.join(' '))
    setError('')
  }, [])

  const remove = useCallback(async (id: string) => {
    setBusy(true)
    setError('')
    try {
      apply(await remote.localAgentRemoveCustomAgent({ id }))
    } catch (failure) {
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }, [apply, remote])

  if (snapshot === undefined) {
    return (
      <div className={css.content}>
        <div className={css.emptyState}>
          <div className={css.emptyTitle}>本机 Agent</div>
          <div className={css.emptyHint}>{error === '' ? '正在扫描本机已安装的 agent…' : error}</div>
        </div>
      </div>
    )
  }

  const detected = snapshot.detected
  const found = detected.filter(entry => entry.available)
  const missing = detected.filter(entry => !entry.available && !entry.custom)

  return (
    <div className={css.content}>
      <div className={css.section}>
        <div className={css.sectionHeading}>
          <span className={css.sectionTitle}>本机 Agent</span>
          <button
            type="button"
            className={css.rowActionButton}
            disabled={busy}
            onClick={() => { void load(() => remote.localAgentRefresh()) }}
          >
            {busy ? '扫描中…' : '刷新'}
          </button>
        </div>
        <div className={css.fieldHint}>
          这些 agent 使用它们自己的登录、模型与规则。Bot 选择本机 Agent 后不需要填写 API Key，也不会注入人设提示词。
        </div>
        {!snapshot.enabled && <div className={css.fieldHint}>本机 Agent 已在配置中关闭。</div>}
        {!snapshot.supported && <div className={css.fieldHint}>当前 DSH 不支持注册本机 Agent 模型路由（仅可查看发现结果）。</div>}
        <div className={css.fieldHint}>
          已注册路由：{snapshot.registeredRoutes.length === 0 ? '无' : snapshot.registeredRoutes.join('、')}
        </div>
      </div>

      {error !== '' && <div className={css.fieldHint} role="alert">{error}</div>}

      <div className={css.section}>
        <div className={css.sectionHeading}>
          <span className={css.sectionTitle}>已检测到</span>
        </div>
        <div className={css.itemList}>
          {found.length === 0 && <div className={css.listEmpty}>没有检测到可用的 agent CLI</div>}
          {found.map(entry => (
            <div key={entry.route} className={css.botRow}>
              <div className={css.rowText}>
                <div className={css.rowName}>{entry.name}</div>
                <div className={css.rowMeta}>
                  {entry.route}
                  {entry.version === undefined ? '' : ` · ${entry.version}`}
                  {entry.path === undefined ? '' : ` · ${entry.path}`}
                </div>
                {entry.signInHint === undefined ? null : (
                  <div className={css.rowMeta}>登录命令：{entry.signInHint}</div>
                )}
              </div>
            </div>
          ))}
        </div>
        {missing.length === 0 ? null : (
          <div className={css.fieldHint}>
            未安装：{missing.map(entry => entry.name).join('、')}
          </div>
        )}
      </div>

      <div className={css.section}>
        <div className={css.sectionHeading}>
          <span className={css.sectionTitle}>自定义 ACP Agent</span>
        </div>
        <div className={css.itemList}>
          {snapshot.custom.length === 0 && <div className={css.listEmpty}>还没有自定义 agent</div>}
          {snapshot.custom.map(agent => (
            <div key={agent.id} className={css.botRow}>
              <div className={css.rowText}>
                <div className={css.rowName}>{agent.name}</div>
                <div className={css.rowMeta}>{agent.command} {agent.args.join(' ')}</div>
              </div>
              <div className={css.rowControl}>
                <button type="button" className={css.rowActionButton} disabled={busy} onClick={() => startEdit(agent)}>编辑</button>
                <button type="button" className={css.rowDeleteButton} disabled={busy} onClick={() => { void remove(agent.id) }}>删除</button>
              </div>
            </div>
          ))}
        </div>
        <div className={css.form}>
          <label className={css.field}>
            <span className={css.fieldLabel}>名称</span>
            <Input value={name} placeholder="例如 My Agent" onChange={event => setName(event.target.value)} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>命令</span>
            <Input value={command} placeholder="例如 my-agent（裸命令或绝对路径）" onChange={event => setCommand(event.target.value)} />
          </label>
          <label className={css.field}>
            <span className={css.fieldLabel}>参数</span>
            <Input value={args} placeholder="例如 acp --stdio" onChange={event => setArgs(event.target.value)} />
          </label>
          <div className={css.rowControl}>
            <Button onClick={() => { void submit() }} disabled={busy}>
              {editingId === undefined ? '添加 ACP Agent' : '保存修改'}
            </Button>
            {editingId === undefined ? null : (
              <Button onClick={resetForm} disabled={busy}>取消</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
