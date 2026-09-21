const DEFAULT_KEYFRAME = Object.freeze({
  mode: 'compact',
  selector: 'h1,h2,h3,input,textarea,select,button,a,label,summary,[role],[contenteditable],[tabindex]',
  fields: ['locator', 'tag', 'role', 'type', 'labels', 'placeholder', 'ariaLabel', 'text', 'checked', 'disabled'],
  limit: 120,
  captureLimit: 500,
  includeText: true,
  textLimit: 3000
})

const DEFAULT_FOCUS = Object.freeze({
  mode: 'compact',
  selector: 'h1,h2,h3,input,textarea,select,button,a,label,summary,[role],[contenteditable],[tabindex]',
  fields: ['locator', 'tag', 'role', 'type', 'labels', 'placeholder', 'ariaLabel', 'text', 'checked', 'disabled'],
  limit: 80,
  captureLimit: 200,
  includeText: true,
  textLimit: 2000,
  semanticScope: true
})

export class AdaptiveReadPolicy {
  constructor({ now = () => Date.now(), maxDeltaChain = 12, keyframeTtlMs = 120000,
    focusTtlMs = 10000, sceneChangeRatio = 0.35 } = {}) {
    this.states = new Map()
    Object.assign(this, { now, maxDeltaChain, keyframeTtlMs, focusTtlMs, sceneChangeRatio })
  }

  clearTab(tabId) {
    this.states.delete(String(tabId))
  }

  state(tabId) {
    const key = String(tabId)
    if (!this.states.has(key)) this.states.set(key, { latestSnapshotId: null, keyframeAt: 0, deltaChain: 0, pendingFocus: null })
    return this.states.get(key)
  }

  noteAction(tabId, action, target) {
    if (!target || !['click', 'fill', 'blur'].includes(action)) return
    this.state(tabId).pendingFocus = { action, target: String(target), at: this.now() }
  }

  decide(tabId, supplied) {
    const started = this.now()
    const options = supplied && typeof supplied === 'object' ? { ...supplied } : {}
    const requestedMode = options.mode
    if (requestedMode === 'full') return { readMode: 'full', reason: 'explicit_full', options: null, decisionMs: this.now() - started }
    if (requestedMode === 'compact') return { readMode: options.scope ? 'focus' : 'keyframe', reason: 'explicit_compact', options, manual: true, decisionMs: this.now() - started }
    if (requestedMode && requestedMode !== 'auto' && requestedMode !== 'focus') throw new Error(`Unknown read mode: ${requestedMode}`)

    const state = this.state(tabId)
    const explicitTarget = options.target || options.scope
    if (requestedMode === 'focus' && !explicitTarget) throw new Error('Focus mode requires target or scope')
    const pending = state.pendingFocus && this.now() - state.pendingFocus.at <= this.focusTtlMs ? state.pendingFocus : null
    const focusTarget = explicitTarget || pending?.target
    if (explicitTarget || (pending && state.latestSnapshotId)) {
      state.pendingFocus = null
      return { readMode: 'focus', reason: explicitTarget ? 'explicit_focus' : `post_${pending.action}`,
        options: { ...DEFAULT_FOCUS, ...options, mode: 'compact', scope: focusTarget, semanticScope: true,
          target: undefined }, decisionMs: this.now() - started }
    }

    const expired = state.keyframeAt && this.now() - state.keyframeAt >= this.keyframeTtlMs
    if (!state.latestSnapshotId || expired || state.deltaChain >= this.maxDeltaChain) {
      return { readMode: 'keyframe', reason: !state.latestSnapshotId ? 'baseline_missing'
        : expired ? 'baseline_expired' : 'delta_chain_limit',
      options: { ...DEFAULT_KEYFRAME, ...options, mode: 'compact', target: undefined },
      decisionMs: this.now() - started }
    }
    return { readMode: 'delta', reason: 'stable_page_with_baseline',
      options: { ...DEFAULT_KEYFRAME, ...options, mode: 'compact', target: undefined, since: state.latestSnapshotId },
      decisionMs: this.now() - started }
  }

  complete(tabId, decision, snapshot) {
    if (decision.manual || decision.readMode === 'full') return decision
    const state = this.state(tabId)
    if (decision.readMode === 'focus') return decision
    state.latestSnapshotId = snapshot.snapshotId
    if (decision.readMode === 'keyframe' || snapshot.reset) {
      state.keyframeAt = this.now()
      state.deltaChain = 0
      if (snapshot.resetReason === 'change_ratio') return { ...decision, readMode: 'keyframe', reason: 'scene_change' }
      if (snapshot.resetReason) return { ...decision, readMode: 'keyframe', reason: snapshot.resetReason }
      return decision
    }
    state.deltaChain++
    return decision
  }
}

export const ADAPTIVE_READ_DEFAULTS = Object.freeze({ keyframe: DEFAULT_KEYFRAME, focus: DEFAULT_FOCUS })
