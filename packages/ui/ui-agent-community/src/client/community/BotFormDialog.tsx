/**
 * BotFormDialog — the create/edit surface for a Bot, and the create surface for a group.
 *
 * Both live in one dialog because they are one dialog in the product: the left column's ＋ opens
 * "新建 Bot" while the Bots tab is showing and "新建群聊" while 群聊 is showing, and only the form
 * inside changes. The shell mounts this component when the form is open and passes `isBotMode`,
 * so the dialog's field state is born and dies with the form: opening it is what initialises the
 * fields (from `editingBot` when editing), and the shell never has to reset them.
 *
 * The dialog owns its edit buffer and both submit paths (`createBot`/`updateBot`, `createRoom`);
 * the shell keeps the snapshot reload (`onSaved`), the notice bar (`setNotice`) and the shared
 * `busy` flag. The model-group list is read here but stored by the shell, because the open room's
 * composer renders the same list.
 *
 * Markup: unchanged — this dialog already rode `NativeDialog`. The tab strip, the avatar picker,
 * every field, every validation message and the footer's `form=` submit wiring are as they were;
 * what moved is the form state and both submit paths.
 */
import { useEffect, useRef, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import type { BotId, BotIdentity } from '@dsh-plugin-agent-community/agent-community'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { NativeDialog } from '../conversation/NativeDialog.tsx'
import { alignEffortId } from './effort-alignment.ts'
import { DialogTabs } from '../conversation/DialogTabs.tsx'
import { NativeCheckbox, NativeSegmentedControl } from '../conversation/NativeControls.tsx'
import { IconFolderOpenRegular } from '../conversation/NativeIcons.tsx'
import { css } from '../styles.ts'
import type { CommunityRemote, ModelCatalogFailure, ModelGroup } from './types.ts'
import { describe } from './types.ts'

const AVATAR_EMOJIS = ['🤖', '🧠', '🦊', '🐙', '🐼', '🐸', '🚀', '🌟', '🎯', '🛠️', '🧭', '🔥', '🌈', '🪐', '🦉', '🐳'] as const

export interface BotFormDialogProps {
  /** True on the Bots tab (create/edit a bot); false on 群聊 (create a group). */
  isBotMode: boolean
  /** Set → the dialog edits this bot; undefined → it creates one. */
  editingBot: BotIdentity | undefined
  /** Live bot directory: the group form's member checkboxes. */
  visibleBots: BotIdentity[]
  /** The shell's shared busy flag: a submit in flight holds every dialog's primary button. */
  busy: boolean
  setBusy: (busy: boolean) => void
  remote: CommunityRemote
  /** Provider/model list, shared with the open room's composer. */
  modelGroups: ModelGroup[]
  setModelGroups: Dispatch<SetStateAction<ModelGroup[]>>
  /** Host default workspace, fetched once by the shell. */
  defaultWorkspace: string
  /** The shell's notice bar: submitting clears it, a failed direct room sets it. */
  setNotice: Dispatch<SetStateAction<string | undefined>>
  /** Cancel / close: the shell drops `editingBot` and unmounts this component. */
  onClose: () => void
  /** Saved: the shell closes the dialog and reloads the snapshot. */
  onSaved: () => void
  /** Opens the custom-CLI manager (ACP agents the user adds by hand). */
  onManageCustomCli?: (() => void) | undefined
}

export function BotFormDialog({
  isBotMode, editingBot, visibleBots, busy, setBusy, remote,
  modelGroups, setModelGroups, defaultWorkspace, setNotice, onClose, onSaved, onManageCustomCli,
}: BotFormDialogProps) {
  // Bot form fields
  const [botName, setBotName] = useState(editingBot?.name ?? '')
  const [botDesc, setBotDesc] = useState(editingBot?.description ?? '')
  const [botPrompt, setBotPrompt] = useState(editingBot?.systemPrompt ?? '')
  // `''` = "ask the provider for its own default" — the only choice that is valid on every
  // route. A model that publishes no reasoning levels rejects EVERY explicit level with
  // UNSUPPORTED_REASONING_EFFORT, so a non-empty default here creates bots that cannot answer.
  const [botEffort, setBotEffort] = useState(editingBot?.reasoningEffort ?? '')
  const [botAvatar, setBotAvatar] = useState(editingBot?.avatar.seed ?? '🤖')
  const [botMentionOnly, setBotMentionOnly] = useState(editingBot?.mentionOnly ?? false)
  // S2-1: the role decides which agent preset backs this bot (成员 = the deployment default;
  // 协调者 = the reduced coordinator preset). Stored as a role, not a raw preset id.
  const [botRole, setBotRole] = useState<'bot' | 'coordinator'>(editingBot?.agentPreset ?? 'bot')
  const [botPermission, setBotPermission] = useState<'read-only' | 'workspace-write' | 'full-access'>(editingBot?.permission ?? 'full-access')
  /**
   * A6: providers registered by the local-agent service. A Bot on one of these runs on the
   * agent's own login/model/rules, so the persona field is hidden — the adapter never sends a
   * system prompt to a local agent (decision D5), and showing the field would promise otherwise.
   */
  const [localRoutes, setLocalRoutes] = useState<ReadonlySet<string>>(new Set())
  /** Every CLI discovery found (available or not) — the local-mode dropdown's source. */
  const [localDetected, setLocalDetected] = useState<readonly { route: string; name: string; version?: string | undefined; available: boolean }[]>([])
  /** A6: 云模型 (API provider) vs 本机 Agent — the product's Bot mode switch. */
  const [botMode, setBotMode] = useState<'cloud' | 'local'>('cloud')
  /** Once the user flips the switch, stop auto-aligning it with the selected provider. */
  const modeTouched = useRef(false)
  /**
   * Which tab of the bot dialog is showing. Identity first: that is what a new bot needs,
   * and the model route is prefilled from the deployment defaults.
   */
  const [botTab, setBotTab] = useState<'identity' | 'runtime'>('identity')
  const [botProvider, setBotProvider] = useState(editingBot?.provider ?? '')
  // The host stores a real id; `default` is this form's "use the CLI's own model" sentinel.
  const [botModel, setBotModel] = useState(editingBot?.model === 'default' ? '' : (editingBot?.model ?? ''))
  const [botWorkspace, setBotWorkspace] = useState(editingBot?.workspace ?? '')
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelError, setModelError] = useState<string>()
  /** Providers Settings configured but whose catalog could not be built. */
  const [modelFailures, setModelFailures] = useState<readonly ModelCatalogFailure[]>([])

  // Full-access risk confirmation. Full access is a ONE-TIME authorization: the bot is already
  // persisted with `permission: 'full-access'`, so the user granted it when they saved that.
  // Asking again on every visit to the settings form made a standing grant look like it had been
  // forgotten. The checkbox stays visible so it can still be revoked.
  const [fullAccessConfirm, setFullAccessConfirm] = useState((editingBot?.permission ?? '') === 'full-access')

  const [formError, setFormError] = useState<string>()

  /**
   * The error line's node, so the dialog can bring it into view when it appears.
   *
   * The line now lives in the footer (see the footer comment), which does not scroll —
   * `scrollIntoView({ block: 'nearest' })` is the belt to that braces: a dialog taller
   * than the viewport, or one whose footer sits below the fold, still lands on the
   * reason after a failed submit instead of leaving the user with nothing on screen.
   */
  const formErrorRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (formError === undefined) return
    const node = formErrorRef.current
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'nearest' })
    }
  }, [formError])

  // Room form fields
  const [roomName, setRoomName] = useState('')
  const [roomMembers, setRoomMembers] = useState<BotId[]>([])

  // Load the model catalog when the create/edit form opens.
  //
  // `modelCatalog()` rather than `listModelGroups()`: the form also needs the deployment
  // default (so a new Bot starts where Settings says) and the providers Settings has
  // configured but that are currently unavailable (so a missing one can be explained
  // instead of silently disappearing).
  useEffect(() => {
    if (!isBotMode) return
    let cancelled = false
    void (async () => {
      setModelsLoading(true)
      try {
        const catalog = await remote.modelCatalog()
        if (cancelled) return
        setModelGroups([...catalog.groups])
        setModelFailures(catalog.failures)
        // Creating: pre-select provider/model/effort. Editing: keep the existing route, but
        // align the stored level once the catalog is known (see below).
        if (editingBot === undefined) {
          const defaultGroup = catalog.default !== undefined
            ? catalog.groups.find(g => g.id === catalog.default?.provider)
            : undefined
          const defaultModel = catalog.default !== undefined
            ? defaultGroup?.models.find(m => m.id === catalog.default?.model)
            : undefined
          const fallbackGroup = defaultGroup ?? catalog.groups[0]
          const fallbackModel = defaultModel ?? fallbackGroup?.models[0]
          setBotProvider(prev => (prev !== '' && catalog.groups.some(g => g.id === prev) ? prev : fallbackGroup?.id ?? ''))
          setBotModel(prev => (prev !== '' ? prev : fallbackModel?.id ?? ''))
          // The level a new Bot starts with is the one its default model publishes.
          const published = fallbackModel?.reasoning?.efforts ?? []
          const publishedDefault = fallbackModel?.reasoning?.defaultEffort
          if (publishedDefault !== undefined && published.some(e => e.id === publishedDefault)) {
            setBotEffort(publishedDefault)
          } else if (published.length > 0) {
            setBotEffort(published[0]!.id)
          } else {
            // The default model publishes no levels, so it rejects every explicit one: the
            // only safe value is the provider default, NOT the deployment's configured effort
            // (which is what the panel used to copy in here and made new Bots unable to answer).
            setBotEffort('')
          }
        } else if (editingBot.provider !== undefined && editingBot.model !== undefined) {
          // Editing: a Bot stored an explicit level that the model no longer publishes (an old
          // 'max' default on a route that publishes nothing, a model row edited in Settings…).
          // Align it as soon as the catalog says what this route accepts, so saving the form
          // cannot keep a level that is guaranteed to reject the request. Only when the model is
          // in the catalog: a temporarily unavailable provider must not silently rewrite the
          // Bot's stored configuration.
          const group = catalog.groups.find(g => g.id === editingBot.provider)
          const entry = group?.models.find(m => m.id === editingBot.model)
          if (entry !== undefined) {
            const published = entry.reasoning?.efforts ?? []
            const fallback = entry.reasoning?.defaultEffort ?? ''
            setBotEffort(prev => alignEffortId(published, fallback, prev))
          }
        }
        setModelError(undefined)
      } catch (e) {
        if (!cancelled) setModelError(describe(e))
      }
      if (!cancelled) setModelsLoading(false)
    })()
    return () => { cancelled = true }
  }, [isBotMode, remote, editingBot, setModelGroups])

  // A6: learn which providers are local agents, so the identity tab can hide the persona
  // field for them. Non-fatal: if the local-agent service is absent the form behaves as before.
  useEffect(() => {
    let cancelled = false
    void remote.localAgentSnapshot().then(
      snapshot => {
        if (cancelled) return
        const routes = new Set(snapshot.registeredRoutes)
        setLocalRoutes(routes)
        setLocalDetected(snapshot.detected.map(entry => ({
          route: entry.route,
          name: entry.name,
          ...(entry.version === undefined ? {} : { version: entry.version }),
          available: entry.available,
        })))
      },
      () => undefined,
    )
    return () => { cancelled = true }
  }, [remote])

  // When opening the create-bot form, pre-fill workspace with DSH default
  useEffect(() => {
    if (isBotMode && editingBot === undefined && botWorkspace === '' && defaultWorkspace !== '') {
      setBotWorkspace(defaultWorkspace)
    }
  }, [isBotMode, editingBot, botWorkspace, defaultWorkspace])

  // A6: keep the Bot mode switch aligned with the selected provider until the user flips it
  // by hand (a prefilled local route must open the form in 本机 Agent mode).
  useEffect(() => {
    if (modeTouched.current) return
    const route = editingBot?.provider ?? botProvider
    if (route === '') return
    const local = localRoutes.has(route)
    setBotMode(local ? 'local' : 'cloud')
    if (local && editingBot === undefined) {
      setBotModel('')
      setBotPermission('workspace-write')
    }
  }, [botProvider, editingBot, localRoutes])

  async function handlePickWorkspace() {
    try {
      const picked = await remote.pickDirectory()
      if (picked !== null) setBotWorkspace(picked)
    } catch (e) {
      setFormError(describe(e))
    }
  }

  /**
   * Display rules for everything model-related in this form.
   *
   * A provider label is Settings' display name, disambiguated by provider id only when two
   * routes share one name. A model name is Settings' name. Reasoning levels are the ones
   * THIS model publishes. Nothing here names a vendor, a model or a fixed set of levels.
   */
  function providerLabelOf(group: ModelGroup): string {
    const name = group.name ?? group.label ?? group.id
    const clashes = modelGroups.filter(other => (other.name ?? other.label ?? other.id) === name).length > 1
    return clashes ? `${name}（${group.id}）` : name
  }

  /** The reasoning levels `provider`/`model` publishes, and that model's own default. */
  function effortsFor(provider: string, model: string): {
    options: Array<{ id: string; name: string }>
    fallback: string
  } {
    const group = modelGroups.find(g => g.id === provider)
    const entry = group?.models.find(m => m.id === model)
    const efforts = entry?.reasoning?.efforts ?? []
    return {
      options: efforts.map(e => ({ id: e.id, name: e.name ?? e.id })),
      fallback: entry?.reasoning?.defaultEffort ?? '',
    }
  }

  /**
   * Move to a level the model actually publishes when the current one is not offered.
   *
   * A model that publishes nothing resolves to `''` (provider default), which is the only
   * value it accepts: keeping the previous value there would preserve a level the route is
   * guaranteed to reject. When the model does publish levels, prefer its own default, else the
   * first published one — never keep a level the model does not offer.
   */
  function alignEffort(provider: string, model: string, previous: string): string {
    const { options, fallback } = effortsFor(provider, model)
    return alignEffortId(options, fallback, previous)
  }

  function handleSelectProvider(next: string) {
    setBotProvider(next)
    const group = modelGroups.find(g => g.id === next)
    const firstModel = group?.models[0]?.id ?? ''
    setBotModel(firstModel)
    setBotEffort(prev => alignEffort(next, firstModel, prev))
  }

  async function handleCreateBot(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (botName.trim() === '') { setFormError('请填写名称'); return }
    if (botProvider === '' || (botMode === 'cloud' && botModel === '')) {
      setFormError(botMode === 'cloud' ? '请选择 Provider 和 Model' : '请选择已安装的 CLI')
      return
    }
    if (botPermission === 'full-access' && !fullAccessConfirm) { setFormError('完全权限需要勾选风险确认'); return }
    // A local Bot with no explicit model still needs a persisted model id: 'default' tells the
    // driver to use whatever the CLI itself is logged into.
    const modelToSend = botModel.trim() !== ''
      ? botModel.trim()
      : botMode === 'local' && botProvider.trim() !== '' ? 'default' : ''
    setBusy(true)
    setFormError(undefined)
    setNotice(undefined)
    try {
      if (editingBot !== undefined) {
        await remote.updateBot({
          id: editingBot.id,
          name: botName.trim(),
          description: botDesc,
          systemPrompt: botPrompt,
          avatarSeed: botAvatar,
          mentionOnly: botMentionOnly,
          permission: botPermission,
          agentPreset: botRole,
          reasoningEffort: botEffort,
          ...(botProvider.trim() !== '' ? { provider: botProvider.trim() } : {}),
          ...(modelToSend !== '' ? { model: modelToSend } : {}),
          ...(botWorkspace.trim() !== '' ? { workspace: botWorkspace.trim() } : {}),
        })
      } else {
        const bot = await remote.createBot({
          name: botName.trim(),
          description: botDesc,
          systemPrompt: botPrompt,
          avatarSeed: botAvatar,
          mentionOnly: botMentionOnly,
          permission: botPermission,
          agentPreset: botRole,
          reasoningEffort: botEffort,
          ...(botProvider.trim() !== '' ? { provider: botProvider.trim() } : {}),
          ...(modelToSend !== '' ? { model: modelToSend } : {}),
          ...(botWorkspace.trim() !== '' ? { workspace: botWorkspace.trim() } : {}),
        })
        try {
          await remote.createRoom({ name: bot.name, directBotId: bot.id, memberIds: [bot.id] })
        } catch (roomError) {
          setNotice(`Bot「${bot.name}」已创建，但直聊房间创建失败：${describe(roomError)}`)
        }
      }
      onSaved()
    } catch (e) {
      setFormError(describe(e))
    }
    setBusy(false)
  }

  async function handleCreateRoom(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setFormError(undefined)
    setNotice(undefined)
    try {
      await remote.createRoom({ name: roomName.trim(), memberIds: roomMembers })
      onSaved()
    } catch (e) {
      setFormError(describe(e))
    }
    setBusy(false)
  }

  const toggleMember = (id: BotId) => {
    setRoomMembers(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
  }

  /** A6: this Bot's route is served by a local agent, not by an API provider. */
  const isLocalRoute = localRoutes.has(botProvider.trim())

  /** Which providers the current mode offers. Cloud hides local routes and vice versa. */
  const selectableGroups = modelGroups.filter(group => (botMode === 'local') === localRoutes.has(group.id))

  /** Switching mode re-picks a provider/model from that mode's pool. */
  const handleSelectMode = (mode: 'cloud' | 'local') => {
    modeTouched.current = true
    setBotMode(mode)
    const pool = mode === 'local'
      ? modelGroups.filter(group => localRoutes.has(group.id))
      : modelGroups.filter(group => !localRoutes.has(group.id))
    const preferred = pool.find(group => group.id === botProvider) ?? pool[0]
    if (preferred === undefined) {
      if (mode === 'local') { setBotProvider(''); setBotModel('') }
      return
    }
    setBotProvider(preferred.id)
    // Local agents default to the CLI's own configured model; cloud keeps the first catalog
    // model because a provider route always needs one.
    const first = mode === 'local' ? undefined : preferred.models[0]
    setBotModel(first?.id ?? '')
    setBotEffort(prev => alignEffort(preferred.id, first?.id ?? '', prev))
    // A local agent runs commands inside its own CLI; the safe default is the workspace, not
    // the deployment's full-access default (which would also demand the risk checkbox).
    if (mode === 'local' && editingBot === undefined) setBotPermission('workspace-write')
  }

  /** Local mode: the CLI itself is the provider; the model defaults to the CLI's own. */
  const handleSelectLocalCli = (route: string) => {
    setBotProvider(route)
    setBotModel('')
    setBotEffort(prev => alignEffort(route, '', prev))
  }

  return (
    <NativeDialog
      open
      onClose={onClose}
      title={isBotMode ? (editingBot !== undefined ? `编辑 Bot：${editingBot.name}` : '新建 Bot') : '新建群聊'}
      description={isBotMode ? '先选择 Bot 类型，再填写它的名字与运行方式。' : undefined}
      closeLabel="关闭"
      footer={(
        // ── THE ERROR LIVES IN THE FOOTER, ABOVE THE BUTTON THAT CAUSED IT ──────
        //
        // It used to render at the bottom of the dialog BODY — and `styles.ts` makes that
        // body the dialog's one scroll container (`.dialog-content > div:not(:first-child)
        // {overflow-y:auto}`). Both forms are taller than the dialog once a team has many
        // bots (the group form lists every bot as a checkbox, the bot form has two tabs),
        // so the host's limit error ("Bot limit 32 reached") was painted below the fold:
        // the user pressed 创建 and saw literally nothing — 「达到 32 个 Bot、64 个群的上限
        // 后，点『创建』没有任何提示」. The footer is outside the scroller and is always
        // where the submit button is, so the reason is never separated from the action.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', minWidth: 0 }}>
          {formError !== undefined && (
            <div
              ref={formErrorRef}
              role="alert"
              className={css.error}
              style={{ fontSize: 12, lineHeight: '18px' }}
            >{formError}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>
              {isBotMode && onManageCustomCli !== undefined ? (
                <button type="button" className={css.rowActionButton} onClick={onManageCustomCli}>
                  ＋ 管理自定义 CLI…
                </button>
              ) : null}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="outline" onClick={onClose}>取消</Button>
            {/* `type` must come after the primitive's own defaults — Button spreads rest over them. */}
            <Button variant="primary" type="submit" form={isBotMode ? 'bot-form' : 'room-form'} disabled={busy}>
              {busy ? (editingBot !== undefined ? '保存中…' : '创建中…') : (editingBot !== undefined ? '保存' : '创建')}
            </Button>
            </div>
          </div>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }}>
        {isBotMode ? (
          <form id="bot-form" className={css.form} onSubmit={handleCreateBot}>
            <div className={css.field}>
              <span className={css.fieldLabel}>Bot 类型</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {(['cloud', 'local'] as const).map(mode => {
                  const selected = botMode === mode
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => handleSelectMode(mode)}
                      aria-pressed={selected}
                      style={{
                        textAlign: 'left', cursor: 'pointer', padding: '12px 14px', borderRadius: 12,
                        display: 'flex', flexDirection: 'column', gap: 6,
                        border: selected ? '1.5px solid var(--dsw-alias-brand-primary, #2563eb)' : '1px solid var(--dsw-alias-border-secondary, #e6e7eb)',
                        background: selected ? 'var(--dsw-alias-fill-secondary, #eff4ff)' : 'transparent',
                        color: 'inherit',
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 13.5 }}>{mode === 'cloud' ? '☁️ 云模型' : '💻 本机 Agent'}</span>
                      <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
                        {mode === 'cloud'
                          ? '使用 DSH 设置里的模型提供方与 API 凭据，可填人设与指令。'
                          : '连接你电脑上已安装的 CLI（Codex、Claude Code 等），用它们自己的登录与模型。'}
                      </span>
                    </button>
                  )
                })}
              </div>
              <span className={css.fieldHint}>先选类型，再填下面的名字与运行方式</span>
            </div>
            <DialogTabs
              idPrefix="ac-bot"
              label="Bot 设置"
              value={botTab}
              onChange={next => setBotTab(next === 'runtime' ? 'runtime' : 'identity')}
              tabs={[
                {
                  value: 'identity',
                  label: '身份',
                  content: (
                    <div className={css.form}>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>头像</span>
                        <div className={css.avatarRow}>
                          {AVATAR_EMOJIS.map(emoji => (
                            <button
                              key={emoji}
                              type="button"
                              className={css.avatarChoice}
                              data-active={botAvatar === emoji ? 'true' : undefined}
                              aria-pressed={botAvatar === emoji}
                              aria-label={`使用头像 ${emoji}`}
                              onClick={() => setBotAvatar(emoji)}
                            >{emoji}</button>
                          ))}
                        </div>
                        <span className={css.fieldHint}>用于区分不同成员</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>名称</span>
                        <Input className={css.textInput} type="text" value={botName} onChange={e => setBotName(e.target.value)} placeholder="例如：视觉设计师" required />
                        <span className={css.fieldHint}>出现在会话与成员列表里</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>描述</span>
                        <Input className={css.textInput} type="text" value={botDesc} onChange={e => setBotDesc(e.target.value)} placeholder="一句话说明它负责什么" />
                        <span className={css.fieldHint}>用来判断群里的消息该交给谁</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>角色</span>
                        <NativeSegmentedControl
                          id="ac-bot-role"
                          label="角色"
                          value={botRole}
                          onChange={(next: string) => setBotRole(next === 'coordinator' ? 'coordinator' : 'bot')}
                          options={[
                            { value: 'bot', label: '成员' },
                            { value: 'coordinator', label: '协调者' },
                          ]}
                        />
                        <span className={css.fieldHint}>
                          {botRole === 'coordinator'
                            ? '只负责任务分派与汇总，不直接执行命令或修改文件。切换角色后，清空本群消息或重启应用才会生效。'
                            : '可以执行命令、读写文件；协调者适合作为群主/队长，只负责安排与汇总。'}
                        </span>
                      </div>
                      {isLocalRoute ? (
                        <div className={css.field}>
                          <span className={css.fieldLabel}>人设与指令</span>
                          <span className={css.fieldHint}>
                            本机 Agent 使用它自己的规则与配置，不注入人设提示词（由被接管的 agent 决定行为）。
                          </span>
                        </div>
                      ) : (
                        <div className={css.field}>
                          <span className={css.fieldLabel}>人设与指令</span>
                          <textarea className={css.textarea} value={botPrompt} onChange={e => setBotPrompt(e.target.value)} placeholder="你是一名…" />
                          <span className={css.fieldHint}>留空使用默认人设；只影响这个 Bot</span>
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  value: 'runtime',
                  label: '运行',
                  content: (
                    <div className={css.form}>
                      {botMode === 'local' ? (
                        <>
                          <div className={css.field}>
                            <span className={css.fieldLabel}>选择已安装的 CLI</span>
                            <span className={css.rowControl}><select className={css.select} value={botProvider} onChange={e => handleSelectLocalCli(e.target.value)} disabled={localDetected.length === 0}>
                              <option value="">{localDetected.length === 0 ? '没有检测到 CLI' : '选择 CLI…'}</option>
                              {localDetected.map(entry => (
                                <option key={entry.route} value={entry.route} disabled={!entry.available && !localRoutes.has(entry.route)}>
                                  {entry.name}{entry.version === undefined ? '' : ' (' + entry.version + ')'}{entry.available || localRoutes.has(entry.route) ? '' : '（未安装）'}
                                </option>
                              ))}
                              {botProvider !== '' && !localDetected.some(entry => entry.route === botProvider) && (
                                <option value={botProvider}>{botProvider}（当前值）</option>
                              )}
                            </select></span>
                            <span className={css.fieldHint}>下拉列出你电脑上检测到的 CLI；未安装的置灰。未登录的 CLI 会在首次对话时报出登录命令。</span>
                          </div>
                          <div className={css.field}>
                            <span className={css.fieldLabel}>使用该 CLI 的模型</span>
                            <span className={css.rowControl}><select className={css.select} value={botModel} onChange={e => { setBotModel(e.target.value); setBotEffort(prev => alignEffort(botProvider, e.target.value, prev)) }} disabled={botProvider === ''}>
                              <option value="">默认（跟随该 CLI 登录的模型）</option>
                              {(modelGroups.find(group => group.id === botProvider)?.models ?? []).map(model => (
                                <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
                              ))}
                            </select></span>
                            <span className={css.fieldHint}>不选则用该 CLI 的默认模型；对话里说「换成 …」只影响当前会话</span>
                          </div>
                        </>
                      ) : (
                        <>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>Provider</span>
                        <span className={css.rowControl}><select className={css.select} value={botProvider} onChange={e => handleSelectProvider(e.target.value)} disabled={modelsLoading || modelGroups.length === 0}>
                          {modelGroups.length === 0 && <option value="">{modelsLoading ? '加载中…' : '没有已配置的 Provider'}</option>}
                          {selectableGroups.map(group => (
                            <option key={group.id} value={group.id}>{providerLabelOf(group)}</option>
                          ))}
                          {botProvider !== '' && !modelGroups.some(g => g.id === botProvider) && (
                            <option value={botProvider}>{botProvider}（当前值，设置中未列出）</option>
                          )}
                        </select></span>
                        {modelFailures.length > 0 && (
                          <span className={css.fieldHint}>
                            设置中另有 {modelFailures.length} 个提供方当前不可用：
                            {modelFailures.map(f => `${f.name ?? f.id}${f.message !== undefined ? `（${f.message}）` : ''}`).join('；')}
                          </span>
                        )}
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>Model</span>
                        <span className={css.rowControl}><select
                          className={css.select}
                          value={botModel}
                          onChange={e => {
                            setBotModel(e.target.value)
                            setBotEffort(prev => alignEffort(botProvider, e.target.value, prev))
                          }}
                          disabled={modelsLoading || botProvider === ''}
                        >
                          {(modelGroups.find(g => g.id === botProvider)?.models ?? []).map(model => (
                            <option key={model.id} value={model.id}>{model.name ?? model.id}</option>
                          ))}
                          {botModel !== '' && !(modelGroups.find(g => g.id === botProvider)?.models ?? []).some(m => m.id === botModel) && (
                            <option value={botModel}>{botModel}（当前值，设置中未列出）</option>
                          )}
                        </select></span>
                        <span className={css.fieldHint}>{modelError !== undefined
                          ? `读取失败：${modelError}`
                          : isLocalRoute
                            ? '本机 Agent：使用该 agent 自己的登录与模型，不需要 API Key'
                            : '模型与提供方来自 DSH 设置，可随时切换'}</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>思考深度</span>
                        <span className={css.rowControl}><select className={css.select} value={botEffort} onChange={e => setBotEffort(e.target.value)}>
                          {(() => {
                            const published = effortsFor(botProvider, botModel).options
                            // Offer exactly what the route accepts. A model that publishes no
                            // levels accepts NONE of the classic off/low/high/max set — the host
                            // throws UNSUPPORTED_REASONING_EFFORT for any explicit value — so
                            // listing them here only lets the user create a bot that can never
                            // answer. '默认' (the empty id) is then the single valid choice.
                            const options = published
                            const items = [...options]
                            if (!items.some(o => o.id === '')) items.unshift({ id: '', name: '默认' })
                            if (botEffort !== '' && !items.some(o => o.id === botEffort)) {
                              items.unshift({ id: botEffort, name: `${botEffort}（当前值，设置中未列出）` })
                            }
                            return items.map(o => <option key={o.id === '' ? '__default' : o.id} value={o.id}>{o.name}</option>)
                          })()}
                        </select></span>
                        <span className={css.fieldHint}>档位由该模型在 DSH 设置中提供；越高越稳，也越慢</span>
                      </div>

                        </>
                      )}
                      <div className={css.field}>
                        <span className={css.fieldLabel}>工作区</span>
                        <div className={css.rowPair}>
                          <Input className={css.textInput} type="text" value={botWorkspace} onChange={e => setBotWorkspace(e.target.value)} placeholder={defaultWorkspace !== '' ? defaultWorkspace : '选择目录'} />
                          <Button className={css.pick} variant="outline" onClick={() => void handlePickWorkspace()} disabled={busy} icon={<IconFolderOpenRegular size={16} />}>选择</Button>
                        </div>
                        <span className={css.fieldHint}>读写文件与执行命令的根目录</span>
                      </div>
                      <div className={css.field}>
                        <span className={css.fieldLabel}>权限</span>
                        <NativeSegmentedControl
                          id="ac-bot-permission"
                          label="权限"
                          value={botPermission}
                          onChange={(next: string) => { setBotPermission(next as 'read-only' | 'workspace-write' | 'full-access'); if (next !== 'full-access') setFullAccessConfirm(false) }}
                          options={[
                            { value: 'read-only', label: '仅查看' },
                            { value: 'workspace-write', label: '工作区内' },
                            { value: 'full-access', label: '完全权限' },
                          ]}
                        />
                        <span className={css.fieldHint}>
                          {botPermission === 'read-only'
                            ? '只能读取文件，不能写文件或执行命令'
                            : botPermission === 'workspace-write'
                              ? '只能在这个 Bot 的工作区里写文件'
                              : '无沙箱限制：可执行任意命令、修改任意文件'}
                        </span>
                        {botPermission === 'full-access' && (
                          <NativeCheckbox
                            checked={fullAccessConfirm}
                            onChange={setFullAccessConfirm}
                            label="我已了解风险：可执行任意命令、修改任意文件"
                          />
                        )}
                      </div>
                      <div className={css.field}>
                        <NativeCheckbox checked={botMentionOnly} onChange={setBotMentionOnly} label="只有被 @ 时才回复" />
                      </div>
                    </div>
                  ),
                },
              ]}
            />
          </form>
        ) : (
          <form id="room-form" className={css.formLegacy} onSubmit={handleCreateRoom}>
            <label>群聊名称 <input type="text" value={roomName} onChange={e => setRoomName(e.target.value)} required /></label>
            <fieldset className={css.members}>
              <legend>添加成员</legend>
              {visibleBots.length === 0
                ? <p className={css.formHint} style={{ margin: '4px 0' }}>还没有 Bot。先切到「Bots」标签创建一个，再回来把它加进群聊。</p>
                : visibleBots.map(bot => (
                  <label key={bot.id} className={css.check}>
                    <input type="checkbox" checked={roomMembers.includes(bot.id)} onChange={() => toggleMember(bot.id)} />
                    {bot.avatar.seed} {bot.name}
                    <small>{bot.description}</small>
                  </label>
                ))}
            </fieldset>
          </form>
        )}
      </div>
    </NativeDialog>
  )
}
