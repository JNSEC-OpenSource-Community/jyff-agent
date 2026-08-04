const STATUS_LABELS = {
  queued: "队列中",
  pending: "未调度",
  preparing: "准备中",
  running: "执行中",
  solved: "已解出",
  failed: "失败",
  timed_out: "已超时",
  cancelled: "已取消",
  interrupted: "已中断",
  closed: "已关闭",
}

const EVENT_LABELS = {
  run_created: "已创建本次尝试",
  run_started: "Agent 开始工作",
  agent_started: "模型开始推理",
  agent_thinking: "💭 思考",
  agent_usage: "本轮用量",
  thinking_level_update: "已切换思考强度",
  agent_message: "Agent 回复",
  human_message: "人工消息",
  tool_started: "开始执行工具",
  tool_finished: "工具执行完成",
  flag_submitted: "Flag 提交结果",
  run_finished: "本次尝试结束",
  run_interrupted: "运行异常中断",
  run_updated: "运行状态更新",
}

const TOOL_LABELS = {
  bash: "终端命令",
  read: "读取文件",
  write: "写入文件",
  edit: "编辑文件",
  list: "浏览目录",
  ctf_challenge_info: "获取题目信息",
  ctf_download_attachment: "下载附件",
  ctf_submit_flag: "提交 Flag",
  ctf_instance_start: "启动远程环境",
  ctf_instance_destroy: "关闭远程环境",
  ctf_blackboard_read: "读取协作黑板",
  ctf_blackboard_record: "更新协作黑板",
}

const SOURCE_LABELS = {
  direct: "直接调用",
  auto: "自主调度",
  manual: "人工调度",
  retry: "自动重试",
  test: "专项测试",
}

const state = {
  snapshot: null,
  selectedChallengeId: null,
  generatedAt: null,
  detailRequest: 0,
  currentDetails: null,
  currentDetailsFingerprint: null,
  modelSettingsRequest: 0,
  modelSettings: null,
  platformSettingsRequest: 0,
  platformSettings: null,
  operationPending: false,
}

const elements = {
  connection: document.querySelector("#connection-indicator"),
  connectionLabel: document.querySelector("#connection-label"),
  lastUpdated: document.querySelector("#last-updated"),
  settingsButton: document.querySelector("#settings-button"),
  platformSettingsButton: document.querySelector("#platform-settings-button"),
  refreshButton: document.querySelector("#refresh-button"),
  contestName: document.querySelector("#contest-name"),
  contestMeta: document.querySelector("#contest-meta"),
  resultCount: document.querySelector("#result-count"),
  challengeList: document.querySelector("#challenge-list"),
  emptyState: document.querySelector("#empty-state"),
  completionRate: document.querySelector("#completion-rate"),
  completionBar: document.querySelector("#completion-bar"),
  environmentCount: document.querySelector("#environment-count"),
  announcementCount: document.querySelector("#announcement-count"),
  announcementList: document.querySelector("#announcement-list"),
  schedulerConsole: document.querySelector("#scheduler-console"),
  schedulerTitle: document.querySelector("#scheduler-title"),
  schedulerDescription: document.querySelector("#scheduler-description"),
  schedulerQueued: document.querySelector("#scheduler-queued"),
  schedulerActive: document.querySelector("#scheduler-active"),
  schedulerCapacity: document.querySelector("#scheduler-capacity"),
  schedulerAttemptLimit: document.querySelector("#scheduler-attempt-limit"),
  schedulerWarning: document.querySelector("#scheduler-warning"),
  autoToggle: document.querySelector("#auto-toggle"),
  autoToggleLabel: document.querySelector("#auto-toggle-label"),
  search: document.querySelector("#search-input"),
  status: document.querySelector("#status-filter"),
  category: document.querySelector("#category-filter"),
  score: document.querySelector("#score-filter"),
  sort: document.querySelector("#sort-filter"),
  filterForm: document.querySelector("#filter-form"),
  resetFilters: document.querySelector("#reset-filters"),
  emptyReset: document.querySelector("#empty-reset"),
  detailDialog: document.querySelector("#detail-dialog"),
  detailTitle: document.querySelector("#detail-title"),
  detailCategory: document.querySelector("#detail-category"),
  detailContent: document.querySelector("#detail-content"),
  detailAction: document.querySelector("#detail-action"),
  detailActionLabel: document.querySelector("#detail-action-label"),
  exportWrap: document.querySelector("#export-wrap"),
  exportLink: document.querySelector("#export-link"),
  exportFull: document.querySelector("#export-full"),
  thinkingLevelWrap: document.querySelector("#thinking-level-wrap"),
  thinkingLevelSelect: document.querySelector("#thinking-level-select"),
  closeDetail: document.querySelector("#close-detail"),
  interventionInput: document.querySelector("#intervention-input"),
  interventionSend: document.querySelector("#intervention-send"),
  interventionHint: document.querySelector("#intervention-hint"),
  modelDialog: document.querySelector("#model-dialog"),
  modelForm: document.querySelector("#model-form"),
  modelStatus: document.querySelector("#model-status"),
  modelStatusTitle: document.querySelector("#model-status-title"),
  modelStatusDescription: document.querySelector("#model-status-description"),
  modelProvider: document.querySelector("#model-provider"),
  modelId: document.querySelector("#model-id"),
  modelBaseUrl: document.querySelector("#model-base-url"),
  modelApiKey: document.querySelector("#model-api-key"),
  modelApiKeyToggle: document.querySelector("#model-api-key-toggle"),
  modelApiKeyState: document.querySelector("#model-api-key-state"),
  clearApiKey: document.querySelector("#clear-api-key"),
  clearApiKeyLabel: document.querySelector("#clear-api-key-label"),
  modelContextWindow: document.querySelector("#model-context-window"),
  modelMaxTokens: document.querySelector("#model-max-tokens"),
  modelThinkingEnabled: document.querySelector("#model-thinking-enabled"),
  modelReasoningEffort: document.querySelector("#model-reasoning-effort"),
  modelReasoningHint: document.querySelector("#model-reasoning-hint"),
  modelPassthroughThinking: document.querySelector(
    "#model-passthrough-thinking",
  ),
  modelPassthroughHint: document.querySelector("#model-passthrough-hint"),
  modelFormError: document.querySelector("#model-form-error"),
  saveModelSettings: document.querySelector("#save-model-settings"),
  saveModelSettingsLabel: document.querySelector("#save-model-settings-label"),
  closeModelSettings: document.querySelector("#close-model-settings"),
  cancelModelSettings: document.querySelector("#cancel-model-settings"),
  platformDialog: document.querySelector("#platform-dialog"),
  platformForm: document.querySelector("#platform-form"),
  platformStatus: document.querySelector("#platform-status"),
  platformStatusTitle: document.querySelector("#platform-status-title"),
  platformStatusDescription: document.querySelector(
    "#platform-status-description",
  ),
  platformProjectId: document.querySelector("#platform-project-id"),
  platformProjectName: document.querySelector("#platform-project-name"),
  platformPlugin: document.querySelector("#platform-plugin"),
  platformPluginDescription: document.querySelector(
    "#platform-plugin-description",
  ),
  platformAuth: document.querySelector("#platform-auth"),
  platformFields: document.querySelector("#platform-fields"),
  platformSecrets: document.querySelector("#platform-secrets"),
  platformSandboxImage: document.querySelector("#platform-sandbox-image"),
  platformNetworkMode: document.querySelector("#platform-network-mode"),
  platformPrivileged: document.querySelector("#platform-privileged"),
  platformFormError: document.querySelector("#platform-form-error"),
  testPlatformSettings: document.querySelector("#test-platform-settings"),
  savePlatformSettings: document.querySelector("#save-platform-settings"),
  savePlatformSettingsLabel: document.querySelector(
    "#save-platform-settings-label",
  ),
  closePlatformSettings: document.querySelector("#close-platform-settings"),
  toastRegion: document.querySelector("#toast-region"),
}

start()

async function start() {
  bindEvents()
  connectEvents()
  try {
    applySnapshot(await getJson("/api/snapshot"))
    void syncModelSettingsSummary()
    void syncPlatformSettingsSummary()
  } catch (error) {
    setConnection("offline", "连接失败")
    toast(errorMessage(error), true)
  }
}

async function syncModelSettingsSummary() {
  try {
    const configuration = await getJson("/api/model-config")
    state.modelSettings = configuration
    renderModelSettings(configuration)
  } catch {
    elements.settingsButton.classList.remove("is-configured")
  }
}

function bindEvents() {
  elements.filterForm.addEventListener("input", renderChallenges)
  elements.filterForm.addEventListener("change", renderChallenges)
  elements.filterForm.addEventListener("reset", () => {
    window.setTimeout(renderChallenges)
  })
  elements.emptyReset.addEventListener("click", resetFilters)
  elements.settingsButton.addEventListener("click", openModelSettings)
  elements.platformSettingsButton.addEventListener(
    "click",
    openPlatformSettings,
  )
  elements.refreshButton.addEventListener("click", refreshPlatform)
  elements.autoToggle.addEventListener("click", toggleAutoScheduler)
  elements.detailAction.addEventListener("click", runDetailAction)
  elements.closeDetail.addEventListener("click", closeDetail)
  elements.exportFull.addEventListener("change", () => {
    // 详情可能未打开(无 currentDetails 时按钮本就隐藏),更新链接只做兜底
    if (state.currentDetails) configureExport(state.currentDetails)
  })
  elements.thinkingLevelSelect.addEventListener("change", changeThinkingLevel)
  elements.interventionSend.addEventListener("click", sendIntervention)
  elements.interventionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendIntervention()
  })
  elements.detailDialog.addEventListener("click", (event) => {
    if (event.target === elements.detailDialog) closeDetail()
  })
  elements.detailDialog.addEventListener("close", () => {
    state.selectedChallengeId = null
    state.currentDetails = null
    state.currentDetailsFingerprint = null
    elements.interventionInput.value = ""
    if (location.hash.startsWith("#challenge=")) {
      history.replaceState(null, "", `${location.pathname}${location.search}`)
    }
  })
  elements.modelForm.addEventListener("submit", saveModelSettings)
  elements.closeModelSettings.addEventListener("click", closeModelSettings)
  elements.cancelModelSettings.addEventListener("click", closeModelSettings)
  elements.modelDialog.addEventListener("click", (event) => {
    if (event.target === elements.modelDialog) closeModelSettings()
  })
  elements.modelDialog.addEventListener("close", resetModelSecretControls)
  elements.modelApiKeyToggle.addEventListener(
    "click",
    toggleModelApiKeyVisibility,
  )
  elements.clearApiKey.addEventListener("change", syncClearApiKey)
  elements.modelApiKey.addEventListener("input", () => {
    if (elements.modelApiKey.value) {
      elements.clearApiKey.checked = false
      syncClearApiKey()
    }
  })
  elements.platformForm.addEventListener("submit", savePlatformSettings)
  elements.testPlatformSettings.addEventListener("click", testPlatformSettings)
  elements.closePlatformSettings.addEventListener(
    "click",
    closePlatformSettings,
  )
  elements.platformDialog.addEventListener("click", (event) => {
    if (event.target === elements.platformDialog) closePlatformSettings()
  })
  elements.platformDialog.addEventListener("close", () => {
    state.platformSettingsRequest++
    clearPlatformSettingsError()
  })
  elements.platformPlugin.addEventListener("change", renderPlatformPlugin)
  elements.platformAuth.addEventListener("change", renderPlatformAuth)
  elements.modelThinkingEnabled.addEventListener("change", () => {
    if (!elements.modelThinkingEnabled.checked) return
    // 开启思考时若尚未选档位,回落到当前支持档位的第一个
    if (
      !elements.modelReasoningEffort.value &&
      !elements.modelReasoningEffort.disabled
    ) {
      elements.modelReasoningEffort.selectedIndex = 0
    }
  })
  window.addEventListener("hashchange", openFromHash)
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !isTypingTarget(event.target)) {
      event.preventDefault()
      elements.search.focus()
    }
  })
  window.setInterval(updateRelativeTimes, 10_000)
}

function connectEvents() {
  const source = new EventSource("/api/events")
  source.addEventListener("open", () => setConnection("online", "实时连接"))
  source.addEventListener("snapshot", (event) => {
    try {
      applySnapshot(JSON.parse(event.data))
    } catch {
      setConnection("offline", "数据异常")
    }
  })
  source.addEventListener("dashboard_error", (event) => {
    setConnection("offline", "同步异常")
    try {
      const data = JSON.parse(event.data)
      toast(data.message || "实时数据同步失败", true)
    } catch {
      toast("实时数据同步失败", true)
    }
  })
  source.addEventListener("error", () => setConnection("offline", "正在重连"))
}

function applySnapshot(snapshot) {
  const previousGeneratedAt = state.generatedAt
  state.snapshot = snapshot
  state.generatedAt = snapshot.generatedAt
  setConnection("online", "实时连接")
  elements.platformSettingsButton.classList.toggle(
    "is-configured",
    snapshot.controlPlane?.phase === "ready",
  )
  renderHeader(snapshot)
  renderScheduler(snapshot.scheduler)
  renderStats(snapshot)
  renderCategories(snapshot.categories)
  renderAnnouncements(snapshot.announcements)
  renderChallenges()
  updateRelativeTimes()
  if (!previousGeneratedAt) openFromHash()
  if (
    state.selectedChallengeId &&
    previousGeneratedAt &&
    previousGeneratedAt !== snapshot.generatedAt
  ) {
    void openDetails(state.selectedChallengeId, false, true)
  }
}

function renderHeader(snapshot) {
  elements.contestName.textContent = snapshot.overview.name
  elements.contestMeta.textContent = `${snapshot.overview.id} · ${snapshot.overview.challenges} 道题 · ${snapshot.stats.attempts} 次 Agent 尝试`
  document.title = `${snapshot.overview.name} · CTF Agent`
}

function renderStats(snapshot) {
  for (const key of [
    "solved",
    "active",
    "queued",
    "pending",
    "attempts",
    "failed",
  ]) {
    const node = document.querySelector(`[data-stat="${key}"]`)
    if (node) node.textContent = String(snapshot.stats[key])
  }
  const solvedNote = document.querySelector('[data-stat-note="solved"]')
  if (solvedNote) solvedNote.textContent = `共 ${snapshot.stats.total} 道题`
  const completion =
    snapshot.stats.total === 0
      ? 0
      : Math.round((snapshot.stats.solved / snapshot.stats.total) * 100)
  elements.completionRate.textContent = `${completion}%`
  elements.completionBar.style.width = `${completion}%`
  const runningEnvironments = snapshot.environments.filter(
    (environment) => environment.status === "running",
  ).length
  elements.environmentCount.textContent = String(runningEnvironments)
  elements.announcementCount.textContent = String(snapshot.announcements.length)
}

function renderScheduler(scheduler) {
  const unavailable = !scheduler?.available
  const autoEnabled = scheduler?.autoEnabled === true
  elements.schedulerConsole.classList.toggle("is-running", autoEnabled)
  elements.schedulerConsole.classList.toggle("is-unavailable", unavailable)
  elements.schedulerTitle.textContent = unavailable
    ? "调度器不可用"
    : autoEnabled
      ? "自主调度运行中"
      : "自主调度已暂停"
  elements.schedulerDescription.textContent = unavailable
    ? (scheduler?.unavailableReason ?? "当前服务仅提供只读监控")
    : autoEnabled
      ? "新题与未解题会自动进入 worker 队列"
      : "人工调度仍可使用，自动队列暂不派发"
  elements.schedulerQueued.textContent = String(scheduler?.queued.length ?? 0)
  elements.schedulerActive.textContent = String(scheduler?.active.length ?? 0)
  elements.schedulerCapacity.textContent = scheduler
    ? `${scheduler.active.length}/${scheduler.maxConcurrent}`
    : "—"
  elements.schedulerAttemptLimit.textContent = scheduler
    ? String(scheduler.maxAttempts)
    : "—"
  elements.autoToggle.disabled = unavailable || state.operationPending
  elements.autoToggle.classList.toggle("is-pause", autoEnabled)
  elements.autoToggleLabel.textContent = autoEnabled
    ? "暂停自主调度"
    : "开启自主调度"
  const icon = elements.autoToggle.querySelector(".control-button-icon")
  if (icon) icon.textContent = autoEnabled ? "Ⅱ" : "▶"
  const warning =
    scheduler?.lastError || (unavailable ? scheduler?.unavailableReason : "")
  elements.schedulerWarning.hidden = !warning
  elements.schedulerWarning.textContent = warning || ""
}

function renderCategories(categories) {
  const renderKey = JSON.stringify(categories)
  if (elements.category.dataset.renderKey === renderKey) return
  const selected = elements.category.value
  const options = [option("all", "全部分类")]
  for (const category of categories) options.push(option(category, category))
  elements.category.replaceChildren(...options)
  elements.category.value = categories.includes(selected) ? selected : "all"
  elements.category.dataset.renderKey = renderKey
}

function renderAnnouncements(announcements) {
  const renderKey = JSON.stringify(announcements)
  if (elements.announcementList.dataset.renderKey === renderKey) return
  elements.announcementList.dataset.renderKey = renderKey
  if (announcements.length === 0) {
    elements.announcementList.replaceChildren(el("p", "muted", "暂无公告"))
    return
  }
  elements.announcementList.replaceChildren(
    ...announcements.map((announcement) => {
      const article = el("article", "announcement-item")
      article.append(
        el("strong", "", announcement.title),
        el("p", "", announcement.content),
        timeElement(announcement.publishedAt, { absolute: true }),
      )
      return article
    }),
  )
}

function renderChallenges() {
  if (!state.snapshot) return
  const challenges = filteredChallenges(state.snapshot.challenges)
  elements.resultCount.textContent = `显示 ${challenges.length} / ${state.snapshot.challenges.length}`
  elements.emptyState.hidden = challenges.length !== 0
  elements.challengeList.hidden = challenges.length === 0
  const scrollY = window.scrollY
  const focusedRow = document.activeElement?.closest?.(".challenge-row")
  const focusedChallengeId = focusedRow?.dataset.challengeId
  const focusedAction =
    document.activeElement?.classList.contains("row-action") === true
  const existingRows = new Map(
    [...elements.challengeList.children]
      .filter((row) => row.dataset.challengeId)
      .map((row) => [row.dataset.challengeId, row]),
  )
  const rows = challenges.map((challenge, index) => {
    const action = challengeControl(challenge)
    const renderKey = JSON.stringify([challenge, action])
    let row = existingRows.get(challenge.id)
    if (!row || row.dataset.renderKey !== renderKey) {
      const replacement = challengeRow(challenge, index, action)
      replacement.dataset.challengeId = challenge.id
      replacement.dataset.renderKey = renderKey
      if (row) row.replaceWith(replacement)
      row = replacement
    } else {
      row.style.setProperty("--row-index", String(index))
      const actionButton = row.querySelector(".row-action")
      if (actionButton) {
        actionButton.disabled = action.disabled || state.operationPending
      }
    }
    return row
  })
  reconcileChildren(elements.challengeList, rows)
  restoreWindowScroll(scrollY)
  if (focusedChallengeId && !focusedRow?.isConnected) {
    const row = rows.find(
      (candidate) => candidate.dataset.challengeId === focusedChallengeId,
    )
    const focusTarget = focusedAction ? row?.querySelector(".row-action") : row
    focusTarget?.focus({ preventScroll: true })
  }
}

function reconcileChildren(parent, desiredChildren) {
  for (let index = 0; index < desiredChildren.length; index++) {
    const desired = desiredChildren[index]
    const current = parent.children[index]
    if (current !== desired) parent.insertBefore(desired, current ?? null)
  }
  while (parent.children.length > desiredChildren.length) {
    parent.lastElementChild?.remove()
  }
}

function restoreWindowScroll(scrollY) {
  const maxScroll = Math.max(
    0,
    document.documentElement.scrollHeight - window.innerHeight,
  )
  const target = Math.min(scrollY, maxScroll)
  if (Math.abs(window.scrollY - target) < 0.5) return
  window.scrollTo({ top: target, left: window.scrollX, behavior: "instant" })
}

function filteredChallenges(challenges) {
  const search = elements.search.value.trim().toLocaleLowerCase()
  const status = elements.status.value
  const category = elements.category.value
  const score = elements.score.value
  const filtered = challenges.filter((challenge) => {
    if (
      search &&
      !`${challenge.title} ${challenge.id}`.toLocaleLowerCase().includes(search)
    )
      return false
    if (category !== "all" && challenge.category !== category) return false
    if (status !== "all" && !matchesStatus(challenge.status, status))
      return false
    if (score === "high" && challenge.score < 400) return false
    if (score === "medium" && (challenge.score < 200 || challenge.score >= 400))
      return false
    if (score === "low" && challenge.score >= 200) return false
    return true
  })
  return filtered.sort(sortChallenges(elements.sort.value))
}

function matchesStatus(actual, filter) {
  if (filter === "active") return actual === "preparing" || actual === "running"
  if (filter === "failed") {
    return ["failed", "timed_out", "cancelled", "interrupted"].includes(actual)
  }
  return actual === filter
}

function sortChallenges(mode) {
  const statusOrder = {
    running: 0,
    preparing: 1,
    queued: 2,
    failed: 3,
    timed_out: 3,
    interrupted: 3,
    cancelled: 3,
    pending: 4,
    closed: 5,
    solved: 6,
  }
  return (left, right) => {
    if (mode === "score-desc")
      return right.score - left.score || titleSort(left, right)
    if (mode === "score-asc")
      return left.score - right.score || titleSort(left, right)
    if (mode === "title") return titleSort(left, right)
    if (mode === "status") {
      return (
        statusOrder[left.status] - statusOrder[right.status] ||
        titleSort(left, right)
      )
    }
    return (
      timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt) ||
      statusOrder[left.status] - statusOrder[right.status] ||
      titleSort(left, right)
    )
  }
}

function challengeRow(challenge, index, action = challengeControl(challenge)) {
  const row = el("div", "challenge-row")
  row.setAttribute("role", "row")
  row.tabIndex = 0
  row.style.setProperty("--row-index", String(index))
  row.setAttribute(
    "aria-label",
    `${challenge.title}，${STATUS_LABELS[challenge.status]}，${challenge.score} 分`,
  )
  row.addEventListener("click", () => openDetails(challenge.id))
  row.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    void openDetails(challenge.id)
  })

  const name = el("span", "challenge-name")
  name.setAttribute("role", "cell")
  name.append(el("strong", "", challenge.title), el("small", "", challenge.id))

  const category = el("span", "category-score")
  category.setAttribute("role", "cell")
  category.append(
    el("span", "category-tag", challenge.category),
    el("span", "score", `${challenge.score} pt`),
  )
  if (challenge.needsEnv) category.append(el("span", "env-tag", "环境"))

  const status = el(
    "span",
    `status-chip status-${challenge.status}`,
    STATUS_LABELS[challenge.status] ?? challenge.status,
  )
  status.setAttribute("role", "cell")

  const progress = el("span", "progress-cell")
  progress.setAttribute("role", "cell")
  progress.append(
    el("strong", "", challenge.progress),
    el(
      "small",
      "",
      challenge.attempts === 0
        ? "尚无运行记录"
        : `${challenge.attempts} 次尝试`,
    ),
  )

  const knowledge = el("span", "knowledge")
  knowledge.setAttribute("role", "cell")
  const evidence = el("span")
  evidence.title = "证据"
  evidence.append(el("i"), document.createTextNode(String(challenge.evidence)))
  const opportunities = el("span")
  opportunities.title = "开放机会"
  opportunities.append(
    el("i"),
    document.createTextNode(String(challenge.openOpportunities)),
  )
  knowledge.append(evidence, opportunities)

  const activity = timeElement(challenge.lastActivityAt)
  activity.classList.add("activity")
  activity.setAttribute("role", "cell")

  const actionButton = el(
    "button",
    `row-action${action.kind === "cancel" ? " is-cancel" : ""}`,
    action.label,
  )
  actionButton.type = "button"
  actionButton.disabled = action.disabled || state.operationPending
  actionButton.addEventListener("click", (event) => {
    event.stopPropagation()
    if (action.kind === "cancel") void cancelChallenge(challenge.id)
    else if (action.kind === "dispatch") void dispatchChallenge(challenge.id)
    else void openDetails(challenge.id)
  })
  row.append(
    name,
    category,
    status,
    progress,
    knowledge,
    activity,
    actionButton,
  )
  return row
}

function challengeControl(challenge) {
  const scheduler = state.snapshot?.scheduler
  if (!scheduler?.available) {
    return { kind: "details", label: "查看", disabled: false }
  }
  if (["queued", "preparing", "running"].includes(challenge.status)) {
    return { kind: "cancel", label: "取消", disabled: false }
  }
  if (challenge.status === "solved") {
    return { kind: "details", label: "查看", disabled: false }
  }
  if (challenge.schedulerAttempts >= scheduler.maxAttempts) {
    return { kind: "dispatch", label: "已耗尽", disabled: true }
  }
  return {
    kind: "dispatch",
    label: challenge.schedulerAttempts > 0 ? "重试" : "调度",
    disabled: false,
  }
}

async function syncPlatformSettingsSummary() {
  try {
    const setup = await getJson("/api/control-plane")
    state.platformSettings = setup
    renderPlatformStatus(setup.state)
    elements.platformSettingsButton.classList.toggle(
      "is-configured",
      setup.state.phase === "ready",
    )
    if (setup.state.phase === "unconfigured" && !elements.platformDialog.open) {
      await openPlatformSettings()
    }
  } catch {
    elements.platformSettingsButton.hidden = true
  }
}

async function openPlatformSettings() {
  const requestId = ++state.platformSettingsRequest
  if (!elements.platformDialog.open) elements.platformDialog.showModal()
  clearPlatformSettingsError()
  setPlatformSettingsBusy(true, "正在读取…")
  setPlatformStatus("loading", "正在读取配置…", "等待控制面响应")
  try {
    const setup = await getJson("/api/control-plane")
    if (requestId !== state.platformSettingsRequest) return
    state.platformSettings = setup
    renderPlatformSettings(setup)
  } catch (error) {
    if (requestId !== state.platformSettingsRequest) return
    const message = errorMessage(error)
    setPlatformStatus("error", "无法读取平台配置", message)
    showPlatformSettingsError(message)
  } finally {
    if (requestId === state.platformSettingsRequest) {
      setPlatformSettingsBusy(false, "保存并连接")
    }
  }
}

function renderPlatformSettings(setup) {
  elements.platformProjectId.value = setup.config?.project?.id ?? "ctf-project"
  elements.platformProjectName.value = setup.config?.project?.name ?? "CTF"
  elements.platformSandboxImage.value =
    setup.config?.sandbox?.image ?? "ctf-agent-solver:latest"
  elements.platformNetworkMode.value =
    setup.config?.sandbox?.networkMode ?? "bridge"
  elements.platformPrivileged.checked =
    setup.config?.sandbox?.privileged === true
  elements.platformPlugin.replaceChildren()
  for (const platform of setup.platforms) {
    elements.platformPlugin.append(option(platform.id, platform.setup.label))
  }
  if (setup.config?.platform?.plugin) {
    elements.platformPlugin.value = setup.config.platform.plugin
  }
  renderPlatformPlugin()
  renderPlatformStatus(setup.state)
}

function selectedPlatform() {
  return state.platformSettings?.platforms.find(
    (platform) => platform.id === elements.platformPlugin.value,
  )
}

function renderPlatformPlugin() {
  const platform = selectedPlatform()
  elements.platformFields.replaceChildren()
  elements.platformAuth.replaceChildren()
  if (!platform) {
    elements.platformPluginDescription.textContent = "没有可配置的平台插件"
    return
  }
  elements.platformPluginDescription.textContent = platform.setup.description
  const storedConfig =
    state.platformSettings?.config?.platform?.plugin === platform.id
      ? objectData(state.platformSettings.config.platform.config)
      : {}
  const config = { ...platform.setup.defaultConfig, ...storedConfig }
  for (const field of platform.setup.fields) {
    const label = el("label", "model-field")
    const title = el("span", "", field.label)
    const input = document.createElement("input")
    input.dataset.platformField = field.key
    input.type = field.type === "integer" ? "number" : field.type
    input.required = field.required
    if (field.placeholder) input.placeholder = field.placeholder
    if (field.minimum !== undefined) input.min = String(field.minimum)
    if (field.maximum !== undefined) input.max = String(field.maximum)
    const value = config[field.key]
    if (value !== undefined) input.value = String(value)
    label.append(title, input)
    elements.platformFields.append(label)
  }
  for (const strategy of platform.setup.authStrategies) {
    elements.platformAuth.append(option(strategy.id, strategy.label))
  }
  const matched = platform.setup.authStrategies.find((strategy) =>
    configContains(config, strategy.config),
  )
  if (matched) elements.platformAuth.value = matched.id
  renderPlatformAuth()
}

function renderPlatformAuth() {
  const platform = selectedPlatform()
  const strategy = platform?.setup.authStrategies.find(
    (candidate) => candidate.id === elements.platformAuth.value,
  )
  elements.platformSecrets.replaceChildren()
  if (!strategy) return
  for (const secret of strategy.secrets) {
    const status = state.platformSettings?.secrets?.[secret.name]
    const label = el("label", "model-field")
    const title = el("span", "", secret.label)
    const input = document.createElement("input")
    input.dataset.platformSecret = secret.name
    input.type = secret.type === "text" ? "text" : "password"
    input.autocomplete = "new-password"
    input.required = secret.required && !status?.configured
    input.placeholder = status?.configured
      ? `已配置（${secretSourceLabel(status.source)}）；留空保持`
      : "请输入凭据"
    label.append(title, input)
    elements.platformSecrets.append(label)
  }
}

function platformSetupPayload() {
  const platform = selectedPlatform()
  if (!platform) throw new Error("请选择平台插件")
  const strategy = platform.setup.authStrategies.find(
    (candidate) => candidate.id === elements.platformAuth.value,
  )
  if (!strategy) throw new Error("请选择认证方式")
  const platformConfig = {
    ...platform.setup.defaultConfig,
    ...strategy.config,
  }
  for (const input of elements.platformFields.querySelectorAll(
    "[data-platform-field]",
  )) {
    if (!input.value.trim()) {
      delete platformConfig[input.dataset.platformField]
      continue
    }
    platformConfig[input.dataset.platformField] =
      input.type === "number" ? Number(input.value) : input.value.trim()
  }
  const secrets = {}
  for (const input of elements.platformSecrets.querySelectorAll(
    "[data-platform-secret]",
  )) {
    if (input.value) secrets[input.dataset.platformSecret] = input.value
  }
  return {
    config: {
      version: 1,
      project: {
        id: elements.platformProjectId.value.trim(),
        name: elements.platformProjectName.value.trim(),
      },
      platform: { plugin: platform.id, config: platformConfig },
      sandbox: {
        image: elements.platformSandboxImage.value.trim(),
        privileged: elements.platformPrivileged.checked,
        networkMode: elements.platformNetworkMode.value,
      },
    },
    secrets,
  }
}

async function testPlatformSettings() {
  clearPlatformSettingsError()
  if (!elements.platformForm.reportValidity()) return
  setPlatformSettingsBusy(true, "正在测试…")
  try {
    const result = await controlPost(
      "/api/control-plane/test",
      platformSetupPayload(),
    )
    setPlatformStatus(
      "ready",
      "平台连接测试成功",
      `${result.overview.name} · ${result.overview.challenges} 道题`,
    )
    toast("平台连接测试成功，配置尚未保存")
  } catch (error) {
    const message = errorMessage(error)
    setPlatformStatus("error", "平台连接测试失败", message)
    showPlatformSettingsError(message)
  } finally {
    setPlatformSettingsBusy(false, "保存并连接")
  }
}

async function savePlatformSettings(event) {
  event.preventDefault()
  clearPlatformSettingsError()
  setPlatformSettingsBusy(true, "正在连接…")
  try {
    const result = await controlPost(
      "/api/control-plane/apply",
      platformSetupPayload(),
    )
    state.platformSettings = result.setup
    applySnapshot(result.snapshot)
    closePlatformSettings()
    toast("比赛平台配置已保存并连接")
  } catch (error) {
    const message = errorMessage(error)
    setPlatformStatus("error", "平台配置未保存", message)
    showPlatformSettingsError(message)
  } finally {
    setPlatformSettingsBusy(false, "保存并连接")
  }
}

function renderPlatformStatus(stateView) {
  if (stateView.phase === "ready") {
    setPlatformStatus(
      "ready",
      "比赛平台已连接",
      `${stateView.platformId} · ${stateView.projectName}`,
    )
  } else if (stateView.phase === "degraded") {
    setPlatformStatus(
      "error",
      "比赛平台连接异常",
      stateView.lastError ?? "请检查配置后重试",
    )
  } else {
    setPlatformStatus("loading", "比赛平台尚未连接", "请填写并测试配置")
  }
}

function setPlatformStatus(kind, title, description) {
  elements.platformStatus.classList.toggle("is-ready", kind === "ready")
  elements.platformStatus.classList.toggle("is-error", kind === "error")
  elements.platformStatusTitle.textContent = title
  elements.platformStatusDescription.textContent = description
}

function setPlatformSettingsBusy(busy, label) {
  for (const input of elements.platformForm.elements) input.disabled = busy
  elements.savePlatformSettingsLabel.textContent = label
  elements.savePlatformSettings.classList.toggle("is-loading", busy)
  elements.platformForm.setAttribute("aria-busy", String(busy))
}

function closePlatformSettings() {
  if (elements.platformDialog.open) elements.platformDialog.close()
}

function showPlatformSettingsError(message) {
  elements.platformFormError.hidden = false
  elements.platformFormError.textContent = message
}

function clearPlatformSettingsError() {
  elements.platformFormError.hidden = true
  elements.platformFormError.textContent = ""
}

function secretSourceLabel(source) {
  return source === "store" ? "Secret Store" : "未设置"
}

function configContains(value, expected) {
  if (!expected || typeof expected !== "object") return value === expected
  if (!value || typeof value !== "object") return false
  return Object.entries(expected).every(([key, child]) =>
    configContains(value[key], child),
  )
}

async function openModelSettings() {
  const requestId = ++state.modelSettingsRequest
  if (!elements.modelDialog.open) elements.modelDialog.showModal()
  elements.modelForm.scrollTop = 0
  clearModelSettingsError()
  setModelSettingsStatus("loading", "正在读取配置…", "等待本地控制面响应")
  setModelSettingsBusy(true, "正在读取…")
  try {
    const configuration = await getJson("/api/model-config")
    if (requestId !== state.modelSettingsRequest) return
    state.modelSettings = configuration
    renderModelSettings(configuration)
  } catch (error) {
    if (requestId !== state.modelSettingsRequest) return
    const message = errorMessage(error)
    setModelSettingsStatus("error", "无法读取模型配置", message)
    showModelSettingsError(message)
  } finally {
    if (requestId === state.modelSettingsRequest) {
      setModelSettingsBusy(false, "保存并应用")
    }
  }
}

async function saveModelSettings(event) {
  event.preventDefault()
  clearModelSettingsError()
  const body = {
    provider: elements.modelProvider.value.trim(),
    modelId: elements.modelId.value.trim(),
    baseUrl: elements.modelBaseUrl.value.trim(),
    contextWindow: Number(elements.modelContextWindow.value),
    maxTokens: Number(elements.modelMaxTokens.value),
    thinkingEnabled: elements.modelThinkingEnabled.checked,
    reasoningEffort: elements.modelReasoningEffort.value,
    passthroughThinking: elements.modelPassthroughThinking.checked,
  }
  if (elements.clearApiKey.checked) {
    body.clearApiKey = true
  } else if (elements.modelApiKey.value.trim()) {
    body.apiKey = elements.modelApiKey.value.trim()
  }
  setModelSettingsBusy(true, "正在应用…")
  try {
    const result = await controlPost("/api/model-config", body)
    state.modelSettings = result.configuration
    renderModelSettings(result.configuration)
    applySnapshot(result.snapshot)
    closeModelSettings()
    toast(
      result.configuration.configured
        ? "模型配置已保存，调度器现在可用"
        : "模型配置已保存，调度器保持暂停",
    )
  } catch (error) {
    const message = errorMessage(error)
    setModelSettingsStatus("error", "配置未保存", message)
    showModelSettingsError(message)
  } finally {
    setModelSettingsBusy(false, "保存并应用")
  }
}

function renderModelSettings(configuration) {
  elements.modelProvider.value = configuration.provider
  elements.modelId.value = configuration.modelId
  elements.modelBaseUrl.value = configuration.baseUrl
  elements.modelContextWindow.value = String(configuration.contextWindow)
  elements.modelMaxTokens.value = String(configuration.maxTokens)
  elements.modelApiKey.value = ""
  elements.modelApiKey.placeholder = configuration.apiKeyConfigured
    ? "已配置；留空则保持现有密钥"
    : "输入新的 API Key"
  elements.modelApiKeyState.textContent = configuration.apiKeyConfigured
    ? `API Key 已配置 · ${apiKeySourceLabel(configuration.apiKeySource)}`
    : "尚未配置密钥"
  elements.modelApiKeyState.classList.toggle(
    "is-configured",
    configuration.apiKeyConfigured,
  )
  elements.clearApiKeyLabel.hidden = !configuration.apiKeyConfigured
  elements.clearApiKey.checked = false
  syncClearApiKey()
  renderThinkingSettings(configuration)
  elements.settingsButton.classList.toggle(
    "is-configured",
    configuration.configured,
  )
  if (configuration.configured) {
    setModelSettingsStatus(
      "ready",
      "模型连接已配置",
      `${configuration.provider} / ${configuration.modelId}`,
    )
  } else {
    setModelSettingsStatus(
      "error",
      "模型配置未完成",
      configuration.unavailableReason ?? "请补全 API Key 与 Model ID",
    )
  }
}

function setModelSettingsStatus(kind, title, description) {
  elements.modelStatus.classList.toggle("is-ready", kind === "ready")
  elements.modelStatus.classList.toggle("is-error", kind === "error")
  elements.modelStatusTitle.textContent = title
  elements.modelStatusDescription.textContent = description
}

function setModelSettingsBusy(busy, label) {
  for (const input of [
    elements.modelProvider,
    elements.modelId,
    elements.modelBaseUrl,
    elements.modelContextWindow,
    elements.modelMaxTokens,
    elements.modelThinkingEnabled,
    elements.modelReasoningEffort,
    elements.modelPassthroughThinking,
    elements.clearApiKey,
  ]) {
    input.disabled = busy
  }
  elements.modelApiKey.disabled = busy || elements.clearApiKey.checked
  elements.modelApiKeyToggle.disabled = busy
  elements.saveModelSettings.disabled = busy
  elements.saveModelSettings.classList.toggle("is-loading", busy)
  elements.saveModelSettingsLabel.textContent = label
  elements.modelForm.setAttribute("aria-busy", String(busy))
}

function syncClearApiKey() {
  const clearing = elements.clearApiKey.checked
  elements.modelApiKey.disabled =
    clearing || elements.modelForm.getAttribute("aria-busy") === "true"
  if (clearing) elements.modelApiKey.value = ""
}

function toggleModelApiKeyVisibility() {
  const visible = elements.modelApiKey.type === "text"
  elements.modelApiKey.type = visible ? "password" : "text"
  elements.modelApiKeyToggle.textContent = visible ? "SHOW" : "HIDE"
  elements.modelApiKeyToggle.setAttribute(
    "aria-label",
    visible ? "显示 API Key" : "隐藏 API Key",
  )
}

/** 思考开关与档位选择:档位来自 supportedThinkingLevels(pi 按模型动态计算)。 */
function renderThinkingSettings(configuration) {
  elements.modelThinkingEnabled.checked = configuration.thinkingEnabled
  // 透传模式仅自定义 Base URL 有意义:无 baseUrl 时禁用并提示
  elements.modelPassthroughThinking.checked = configuration.passthroughThinking
  elements.modelPassthroughThinking.disabled =
    !configuration.baseUrl ||
    elements.modelForm.getAttribute("aria-busy") === "true"
  elements.modelPassthroughHint.textContent = configuration.baseUrl
    ? "勾选后自定义 Base URL 场景全档位同名直通（xhigh/max 真实透传），适用于支持 reasoning_effort 的中转站。"
    : "仅填写自定义 Base URL 时有效（当前使用 Pi 内置模型，档位已按模型映射自动生效）。"
  const levels = configuration.supportedThinkingLevels ?? []
  const select = elements.modelReasoningEffort
  const previous = select.value
  select.replaceChildren()
  if (levels.length === 0 || levels.includes("off")) {
    select.append(new Option("—", ""))
    select.disabled = true
    elements.modelReasoningHint.textContent =
      levels.length === 0
        ? "配置不完整，无法计算档位；先保存 Provider/Model ID 再调整。"
        : "当前模型仅支持关闭思考（off）。"
  } else {
    for (const level of levels) select.append(new Option(level, level))
    select.disabled = false
    elements.modelReasoningHint.textContent =
      "档位随模型动态计算（pi 按模型的 thinkingLevelMap 推导）；运行中的 Agent 可在题目详情页单独切换。"
  }
  if (levels.includes(configuration.reasoningEffort)) {
    select.value = configuration.reasoningEffort
  } else if (previous && levels.includes(previous)) {
    select.value = previous
  } else {
    select.value = ""
  }
  // 模型不支持当前档位时提示将钳制到哪档
  if (
    configuration.reasoningEffort &&
    !levels.includes(configuration.reasoningEffort)
  ) {
    elements.modelReasoningHint.textContent = `当前档位 ${configuration.reasoningEffort} 该模型不支持，将按 pi 钳制规则生效（建议在下方档位中选择）。`
  }
}

function resetModelSecretControls() {
  state.modelSettingsRequest++
  elements.modelApiKey.type = "password"
  elements.modelApiKey.value = ""
  elements.modelApiKeyToggle.textContent = "SHOW"
  elements.modelApiKeyToggle.setAttribute("aria-label", "显示 API Key")
  elements.clearApiKey.checked = false
  clearModelSettingsError()
}

function closeModelSettings() {
  if (elements.modelDialog.open) elements.modelDialog.close()
}

function showModelSettingsError(message) {
  elements.modelFormError.hidden = false
  elements.modelFormError.textContent = message
}

function clearModelSettingsError() {
  elements.modelFormError.hidden = true
  elements.modelFormError.textContent = ""
}

function apiKeySourceLabel(source) {
  if (source === "secret-store") return "Secret Store"
  return "未设置"
}

async function refreshPlatform() {
  elements.refreshButton.classList.add("is-loading")
  elements.refreshButton.disabled = true
  try {
    applySnapshot(await controlPost("/api/refresh"))
    toast("平台数据已刷新")
  } catch (error) {
    toast(errorMessage(error), true)
  } finally {
    elements.refreshButton.classList.remove("is-loading")
    elements.refreshButton.disabled = false
  }
}

async function toggleAutoScheduler() {
  const scheduler = state.snapshot?.scheduler
  if (!scheduler?.available) return
  const path = scheduler.autoEnabled
    ? "/api/scheduler/auto/pause"
    : "/api/scheduler/auto/start"
  await controlOperation(
    () => controlPost(path),
    scheduler.autoEnabled ? "自主调度已暂停" : "自主调度已开启",
  )
}

async function dispatchChallenge(challengeId, force = false) {
  await controlOperation(
    () =>
      controlPost(
        `/api/challenges/${encodeURIComponent(challengeId)}/dispatch`,
        { force },
      ),
    force ? "重新验证任务已入队" : "题目已加入调度队列",
  )
}

async function cancelChallenge(challengeId) {
  await controlOperation(
    () =>
      controlPost(`/api/challenges/${encodeURIComponent(challengeId)}/cancel`),
    "已发送取消请求",
  )
}

async function controlOperation(operation, successMessage) {
  if (state.operationPending) return
  state.operationPending = true
  if (state.snapshot) {
    renderScheduler(state.snapshot.scheduler)
    renderChallenges()
  }
  try {
    applySnapshot(await operation())
    toast(successMessage)
  } catch (error) {
    toast(errorMessage(error), true)
  } finally {
    state.operationPending = false
    if (state.snapshot) {
      renderScheduler(state.snapshot.scheduler)
      renderChallenges()
    }
  }
}

function runDetailAction() {
  const challenge = state.currentDetails?.challenge
  if (!challenge) return
  if (["queued", "preparing", "running"].includes(challenge.status)) {
    void cancelChallenge(challenge.id)
    return
  }
  const scheduler = state.snapshot?.scheduler
  const force =
    challenge.status === "solved" ||
    Boolean(scheduler && challenge.schedulerAttempts >= scheduler.maxAttempts)
  if (
    force &&
    !window.confirm(
      `确认重新验证 ${challenge.title}？这会产生一次新的模型调用。`,
    )
  ) {
    return
  }
  void dispatchChallenge(challenge.id, force)
}

async function openDetails(
  challengeId,
  updateHash = true,
  preserveView = false,
) {
  const requestId = ++state.detailRequest
  const refreshingOpenDetail =
    preserveView &&
    elements.detailDialog.open &&
    state.selectedChallengeId === challengeId &&
    state.currentDetails !== null
  state.selectedChallengeId = challengeId
  if (updateHash) {
    history.replaceState(
      null,
      "",
      `#challenge=${encodeURIComponent(challengeId)}`,
    )
  }
  if (!elements.detailDialog.open) elements.detailDialog.showModal()
  if (!refreshingOpenDetail) showDetailLoading()
  try {
    const details = await getJson(
      `/api/challenges/${encodeURIComponent(challengeId)}`,
    )
    if (
      requestId !== state.detailRequest ||
      state.selectedChallengeId !== challengeId
    )
      return
    const fingerprint = detailFingerprint(details)
    const viewState = refreshingOpenDetail ? captureDetailViewState() : null
    state.currentDetails = details
    if (
      refreshingOpenDetail &&
      fingerprint === state.currentDetailsFingerprint
    ) {
      configureDetailAction(details.challenge)
      configureExport(details)
      configureThinkingLevel(details.challenge)
      configureIntervention(details.challenge)
      return
    }
    state.currentDetailsFingerprint = fingerprint
    renderDetails(details, viewState)
  } catch (error) {
    if (requestId !== state.detailRequest) return
    if (refreshingOpenDetail) {
      toast(`题目详情同步失败：${errorMessage(error)}`, true)
      return
    }
    elements.detailContent.replaceChildren(
      el("div", "detail-empty", `无法读取题目详情：${errorMessage(error)}`),
    )
  }
}

function showDetailLoading() {
  elements.detailTitle.textContent = "正在读取…"
  elements.detailCategory.textContent = "CHALLENGE DETAIL"
  elements.detailAction.hidden = true
  const loading = el("div", "detail-loading")
  loading.append(
    el("span"),
    el("span"),
    el("span"),
    el("p", "", "正在读取运行记录…"),
  )
  elements.detailContent.replaceChildren(loading)
}

function renderDetails(details, viewState = null) {
  const challenge = details.challenge
  elements.detailTitle.textContent = challenge.title
  elements.detailCategory.textContent = `${challenge.category.toUpperCase()} / ${challenge.id}`
  configureDetailAction(challenge)
  configureExport(details)
  configureThinkingLevel(challenge)
  configureIntervention(challenge)

  const overview = el("div", "detail-overview")
  overview.append(
    metric("状态", STATUS_LABELS[challenge.status] ?? challenge.status),
    metric("分值", `${challenge.score} PT`),
    metric("环境", challenge.needsEnv ? "需申请" : "无需"),
    metric("尝试", String(challenge.attempts)),
    metric(
      "证据 / 机会",
      `${challenge.evidence} / ${challenge.openOpportunities}`,
    ),
  )

  const progress = section("当前进度", "")
  const progressCard = el("div", "current-progress")
  progressCard.append(
    el("strong", "", challenge.progress),
    el(
      "span",
      "",
      challenge.lastActivityAt
        ? `最近活动 ${relativeTime(challenge.lastActivityAt)}`
        : "等待首次调度",
    ),
  )
  if (challenge.queuePosition) {
    progressCard.append(
      el("span", "", ` · 队列位置 #${challenge.queuePosition}`),
    )
  }
  progress.body.append(progressCard)

  const nodes = []
  const submission = acceptedSubmission(details.runs)
  if (submission) nodes.push(submissionCard(submission))
  nodes.push(overview, progress.root)
  if (details.environment) nodes.push(environmentSection(details.environment))
  nodes.push(
    runsSection(details.runs, viewState?.openRunIds),
    blackboardSection(details.blackboard),
  )
  elements.detailContent.replaceChildren(...nodes)
  if (viewState) {
    const maxScroll = Math.max(
      0,
      elements.detailContent.scrollHeight - elements.detailContent.clientHeight,
    )
    elements.detailContent.scrollTop = Math.min(viewState.scrollTop, maxScroll)
  }
}

function captureDetailViewState() {
  return {
    scrollTop: elements.detailContent.scrollTop,
    openRunIds: new Set(
      [...elements.detailContent.querySelectorAll("details.run-card[open]")]
        .map((card) => card.dataset.runId)
        .filter(Boolean),
    ),
  }
}

function detailFingerprint(details) {
  const { generatedAt: _generatedAt, ...content } = details
  return JSON.stringify(content)
}

function configureDetailAction(challenge) {
  const scheduler = state.snapshot?.scheduler
  if (!scheduler?.available) {
    elements.detailAction.hidden = true
    return
  }
  elements.detailAction.hidden = false
  elements.detailAction.disabled = state.operationPending
  const cancelling = ["queued", "preparing", "running"].includes(
    challenge.status,
  )
  const exhausted = challenge.schedulerAttempts >= scheduler.maxAttempts
  elements.detailAction.classList.toggle("is-pause", cancelling)
  elements.detailActionLabel.textContent = cancelling
    ? "取消任务"
    : challenge.status === "solved"
      ? "重新验证"
      : exhausted
        ? "强制重试"
        : challenge.schedulerAttempts > 0
          ? "重试"
          : "立即调度"
}

// 运行中思考强度切换:仅活跃 run 时可用;档位来自模型配置的 supportedThinkingLevels。
// 切换走 POST /api/challenges/:id/thinking-level,下一 turn 边界生效(服务端权威判定 409)。
function configureThinkingLevel(challenge) {
  const levels = state.modelSettings?.supportedThinkingLevels ?? []
  const active = ["running", "preparing"].includes(challenge.status)
  elements.thinkingLevelWrap.hidden = !active || levels.length === 0
  if (elements.thinkingLevelWrap.hidden) return
  const select = elements.thinkingLevelSelect
  const previous = select.value
  select.replaceChildren(new Option("—", ""))
  for (const level of levels) {
    if (level === "off") continue
    select.append(new Option(level, level))
  }
  select.disabled = state.operationPending
  select.value = previous
}

async function changeThinkingLevel(event) {
  const level = event.target.value
  if (!level) return
  const challengeId = state.selectedChallengeId
  if (!challengeId) return
  event.target.value = ""
  try {
    await controlPost(
      `/api/challenges/${encodeURIComponent(challengeId)}/thinking-level`,
      { level },
    )
    toast(`思考强度已切换为 ${level}，下一轮推理生效`)
    void openDetails(challengeId, false, true)
  } catch (error) {
    event.target.value = ""
    toast(`切换思考强度失败：${errorMessage(error)}`, true)
  }
}

// 会话复盘导出:有 run 记录才显示;「明文」勾选切换 full=1 参数。
function configureExport(details) {
  const hasRuns = details.runs.length > 0
  elements.exportWrap.hidden = !hasRuns
  if (!hasRuns) return
  const id = encodeURIComponent(details.challenge.id)
  elements.exportLink.href =
    `/api/challenges/${id}/export` +
    (elements.exportFull.checked ? "?full=1" : "")
}

// 干涉栏只更新禁用态与提示文案,不重建输入框(#detail-content 每 snapshot 重建,
// 输入框位于 #detail-shell 内,焦点/输入值不受影响;权威判定在服务端 409)。
function configureIntervention(challenge) {
  const active =
    Boolean(challenge) && ["running", "preparing"].includes(challenge.status)
  const blocked = !active || state.operationPending
  elements.interventionInput.disabled = blocked
  elements.interventionSend.disabled = blocked
  elements.interventionHint.textContent = active
    ? "消息将发送给该题当前运行的 Agent，并在下一轮推理时注入"
    : "该题当前没有运行中的 Agent，消息暂不可用"
}

async function sendIntervention() {
  const challengeId = state.selectedChallengeId
  const text = elements.interventionInput.value.trim()
  if (!challengeId || !text || elements.interventionSend.disabled) return
  elements.interventionSend.disabled = true
  elements.interventionInput.disabled = true
  try {
    await controlPost(
      `/api/challenges/${encodeURIComponent(challengeId)}/message`,
      { text },
    )
    elements.interventionInput.value = ""
    toast("已发送，将在下一轮推理时注入")
    // 立即重取详情,不依赖 1s 轮询
    void openDetails(challengeId, false, true)
  } catch (error) {
    toast(errorMessage(error), true)
  } finally {
    elements.interventionSend.disabled = false
    configureIntervention(state.currentDetails?.challenge)
  }
}

function acceptedSubmission(runs) {
  for (const run of runs) {
    for (let index = run.events.length - 1; index >= 0; index--) {
      const event = run.events[index]
      if (event?.type !== "flag_submitted") continue
      const data = objectData(event.data)
      if (!["accepted", "already_solved"].includes(data.status)) continue
      if (!data.flag || data.flag === "[redacted]") continue
      return { flag: String(data.flag), status: String(data.status), run }
    }
  }
  return null
}

function submissionCard(submission) {
  const card = el("div", "accepted-submission")
  card.append(
    el(
      "span",
      "",
      submission.status === "accepted"
        ? "PLATFORM CONFIRMED FLAG"
        : "PLATFORM ALREADY SOLVED",
    ),
    el("code", "", submission.flag),
  )
  return card
}

function environmentSection(environment) {
  const area = section("远程环境", environment.status)
  const card = el("div", "environment-card")
  card.append(
    el("strong", "", environment.id),
    el("span", "", environment.status),
    el("code", "", environment.endpoint || "端点尚未就绪"),
  )
  area.body.append(card)
  return area.root
}

function runsSection(runs, openRunIds) {
  const area = section("运行时间线", `${runs.length} 次尝试`)
  if (runs.length === 0) {
    area.body.append(el("div", "detail-empty", "此题尚未分配 Agent。"))
    return area.root
  }

  runs.forEach((run, index) => {
    const card = document.createElement("details")
    card.className = "run-card"
    card.dataset.runId = run.id
    card.open = openRunIds ? openRunIds.has(run.id) : index === 0
    const summary = document.createElement("summary")
    const title = el("span", "run-card-title")
    title.append(
      el("strong", "", `ATTEMPT ${String(run.attempt).padStart(2, "0")}`),
      el(
        "span",
        "",
        `${SOURCE_LABELS[run.source] ?? run.source} · ${shortId(run.id)} · ${absoluteTime(run.createdAt)}`,
      ),
    )
    summary.append(
      title,
      el(
        "span",
        `status-chip status-${run.status}`,
        STATUS_LABELS[run.status] ?? run.status,
      ),
    )
    // 单次会话导出:点击不触发 details toggle(stopPropagation 拦截冒泡)。
    const exportLink = document.createElement("a")
    exportLink.className = "run-export-link"
    exportLink.download = true
    exportLink.textContent = "导出本次"
    exportLink.href =
      `/api/challenges/${encodeURIComponent(run.challengeId)}/export` +
      `?run=${encodeURIComponent(run.id)}`
    exportLink.addEventListener("click", (event) => event.stopPropagation())
    summary.append(exportLink)
    card.append(summary)

    const timeline = el("div", "timeline")
    if (run.events.length === 0) {
      timeline.append(el("div", "detail-empty", "没有持久化事件。"))
    } else {
      // 流式思维链:agent_thinking 是逐词片事件,连续词片聚合为一个思考块展示
      let thinkingText = ""
      let thinkingAt = ""
      const flushThinking = () => {
        if (!thinkingText) return
        timeline.append(thinkingItem(thinkingText, thinkingAt))
        thinkingText = ""
        thinkingAt = ""
      }
      for (const event of run.events) {
        if (event.type === "agent_thinking") {
          const data = objectData(event.data)
          if (typeof data?.text === "string") {
            if (!thinkingAt) thinkingAt = event.createdAt
            thinkingText += data.text
          }
          continue
        }
        flushThinking()
        timeline.append(eventItem(event))
      }
      flushThinking()
    }
    card.append(timeline)
    if (run.error || run.cleanupError) {
      const errors = [
        run.error ? `运行错误：${run.error}` : "",
        run.cleanupError ? `清理错误：${run.cleanupError}` : "",
      ]
        .filter(Boolean)
        .join("\n")
      card.append(el("pre", "run-errors", errors))
    }
    area.body.append(card)
  })
  return area.root
}

/** 聚合的流式思维链块(一轮思考 = 若干 agent_thinking 词片拼接)。 */
function thinkingItem(text, createdAt) {
  const item = el("div", "timeline-item is-thinking")
  item.append(
    el("strong", "", "💭 思考"),
    timeElement(createdAt ?? new Date().toISOString(), { absolute: true }),
  )
  const thinking = document.createElement("details")
  thinking.className = "thinking-details"
  const summary = document.createElement("summary")
  summary.textContent = "思考过程"
  thinking.append(summary, el("p", "thinking-text", text))
  item.append(thinking)
  return item
}

function eventItem(event) {
  const data = objectData(event.data)
  const item = el("div", "timeline-item")
  if (event.type.startsWith("tool_")) item.classList.add("is-tool")
  if (event.type === "agent_thinking") item.classList.add("is-thinking")
  if (event.type === "human_message") item.classList.add("is-human")
  if (event.type === "agent_message") item.classList.add("is-agent")
  if (
    event.type === "flag_submitted" &&
    ["accepted", "already_solved"].includes(data.status)
  ) {
    item.classList.add("is-success")
  }
  if (event.type === "run_finished" && data.reason === "submitted") {
    item.classList.add("is-success")
  }
  if (event.type === "run_interrupted" || data.isError === true) {
    item.classList.add("is-error")
  }
  let label = EVENT_LABELS[event.type] ?? event.type
  if (event.type.startsWith("tool_") && data.toolName) {
    label = `${label} · ${TOOL_LABELS[data.toolName] ?? data.toolName}`
  }
  item.append(
    el("strong", "", label),
    timeElement(event.createdAt, { absolute: true }),
  )
  const detail = eventDetail(event.type, data)
  if (detail) {
    if (event.type === "agent_thinking") {
      const thinking = document.createElement("details")
      thinking.className = "thinking-details"
      const summary = document.createElement("summary")
      summary.textContent = "思考过程"
      thinking.append(summary, el("p", "thinking-text", detail))
      item.append(thinking)
    } else {
      const detailNode = el("p", "", detail)
      if (event.type.startsWith("tool_") || event.type === "flag_submitted") {
        detailNode.classList.add("trace-output")
      }
      item.append(detailNode)
    }
  }
  return item
}

function eventDetail(type, data) {
  if (type === "run_created" && data.attempt !== undefined) {
    const source = SOURCE_LABELS[data.source] ?? data.source ?? "未知来源"
    return `第 ${data.attempt} 次尝试已创建 · ${source}`
  }
  if (
    type === "agent_thinking" ||
    type === "agent_message" ||
    type === "human_message"
  ) {
    return String(data.text ?? "").slice(0, 2000)
  }
  if (
    type === "tool_started" &&
    data.args &&
    Object.keys(data.args).length > 0
  ) {
    if (data.toolName === "bash" && typeof data.args.command === "string") {
      return data.args.command
    }
    return prettyJson(data.args)
  }
  if (type === "tool_finished") {
    if (data.result !== undefined) return prettyJson(data.result)
    return data.isError ? "工具返回错误，Agent 将依据结果继续判断" : ""
  }
  if (type === "flag_submitted") {
    return [
      `状态：${data.status ?? "unknown"}`,
      data.flag ? `Flag：${data.flag}` : "",
      data.message ? `平台消息：${data.message}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  }
  if (type === "run_finished") {
    const reasons = {
      submitted: "正确 Flag 已提交，资源清理完成",
      manual: "调用方主动关闭",
      failed: "Agent 执行失败",
      timed_out: "达到单次运行时限",
      cancelled: "由调度控制面取消",
    }
    return data.reason
      ? (reasons[data.reason] ?? `关闭原因：${data.reason}`)
      : ""
  }
  if (type === "run_interrupted" && data.previousStatus) {
    return `中断前状态：${data.previousStatus}`
  }
  return ""
}

function blackboardSection(blackboard) {
  const evidence = blackboard.evidence ?? []
  const opportunities = blackboard.opportunities ?? []
  const area = section(
    "协作黑板",
    `${evidence.length} 条证据 · ${opportunities.length} 个机会`,
  )
  if (evidence.length === 0 && opportunities.length === 0) {
    area.body.append(
      el("div", "detail-empty", "Agent 尚未记录可复用的证据或解题机会。"),
    )
    return area.root
  }

  const grid = el("div", "blackboard-grid")
  for (const record of evidence) {
    const card = el("article", "knowledge-card")
    card.append(
      el("small", "", `Evidence #${record.id}`),
      el("p", "", record.description),
    )
    grid.append(card)
  }
  for (const record of opportunities) {
    const card = el(
      "article",
      `knowledge-card ${record.status === "open" ? "is-open" : "is-concluded"}`,
    )
    card.append(
      el(
        "small",
        "",
        `${record.status === "open" ? "Open" : "Concluded"} opportunity #${record.id}`,
      ),
      el("p", "", record.description),
    )
    grid.append(card)
  }
  area.body.append(grid)
  return area.root
}

function section(title, count) {
  const root = el("section", "detail-section")
  const heading = el("div", "detail-section-heading")
  heading.append(el("h3", "", title))
  if (count) heading.append(el("span", "", count))
  const body = el("div", "detail-section-body")
  root.append(heading, body)
  return { root, body }
}

function metric(label, value) {
  const node = el("div", "detail-metric")
  node.append(el("span", "", label), el("strong", "", value))
  return node
}

function openFromHash() {
  if (!state.snapshot) return
  const params = new URLSearchParams(location.hash.slice(1))
  const challengeId = params.get("challenge")
  if (
    challengeId &&
    state.snapshot.challenges.some(
      (challenge) => challenge.id === challengeId,
    ) &&
    challengeId !== state.selectedChallengeId
  ) {
    void openDetails(challengeId, false)
  }
}

function closeDetail() {
  state.detailRequest++
  if (elements.detailDialog.open) elements.detailDialog.close()
}

function resetFilters() {
  elements.filterForm.reset()
  renderChallenges()
}

function setConnection(status, label) {
  elements.connection.classList.toggle("is-online", status === "online")
  elements.connection.classList.toggle("is-offline", status === "offline")
  elements.connectionLabel.textContent = label
}

function updateRelativeTimes() {
  if (state.generatedAt) {
    elements.lastUpdated.textContent = `更新于 ${relativeTime(state.generatedAt)}`
    elements.lastUpdated.dateTime = state.generatedAt
  }
  for (const node of document.querySelectorAll("time[data-relative]")) {
    node.textContent = relativeTime(node.dateTime)
  }
}

function timeElement(value, options = {}) {
  const node = document.createElement("time")
  if (!value) {
    node.textContent = "暂无"
    return node
  }
  node.dateTime = value
  node.title = absoluteTime(value)
  if (options.absolute) {
    node.textContent = absoluteTime(value)
  } else {
    node.dataset.relative = "true"
    node.textContent = relativeTime(value)
  }
  return node
}

function relativeTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000)
  const absolute = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" })
  if (absolute < 60) return formatter.format(seconds, "second")
  if (absolute < 3_600)
    return formatter.format(Math.round(seconds / 60), "minute")
  if (absolute < 86_400)
    return formatter.format(Math.round(seconds / 3_600), "hour")
  return formatter.format(Math.round(seconds / 86_400), "day")
}

function absoluteTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "时间未知"
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date)
}

async function getJson(url, init) {
  const response = await fetch(url, init)
  const data = await response.json()
  if (!response.ok)
    throw new Error(data.message || data.error || `HTTP ${response.status}`)
  return data
}

function controlPost(url, body = {}) {
  return getJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function option(value, label) {
  const node = document.createElement("option")
  node.value = value
  node.textContent = label
  return node
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== "") node.textContent = text
  return node
}

function objectData(value) {
  return value && typeof value === "object" ? value : {}
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2)
}

function titleSort(left, right) {
  return left.title.localeCompare(right.title, "zh-CN")
}

function timestamp(value) {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function shortId(value) {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`
}

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable === true
  )
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function toast(message, isError = false) {
  const node = el("div", `toast${isError ? " is-error" : ""}`, message)
  elements.toastRegion.append(node)
  window.setTimeout(() => node.remove(), 3_500)
}
