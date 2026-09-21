// This function is serialized into the inspected page by the service worker.
// Keep it self-contained: it must not depend on extension globals or imports.
export function createPageTools() {
  const SELECTOR = 'input,textarea,select,button,a,label,summary,[role],[contenteditable],[tabindex]'
  const MAX_CONTEXT_DEPTH = 5
  const MAX_NODES_PER_CONTEXT = 20000
  let scanTruncated = false
  const visible = el => {
    if (!el.isConnected || !el.getClientRects().length) return false
    const style = el.ownerDocument.defaultView.getComputedStyle(el)
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    const frame = el.ownerDocument.defaultView.frameElement
    return !frame || visible(frame)
  }
  const trim = value => String(value ?? '').trim()
  const textOf = el => ['password', 'hidden'].includes(el.type) ? '' : trim(el.innerText || el.textContent || el.value).slice(0, 300)
  const cssEscape = value => CSS.escape(String(value))

  function selectorFor(el, root) {
    if (el.id) {
      const byId = `#${cssEscape(el.id)}`
      if (root.querySelectorAll(byId).length === 1) return byId
    }
    const segments = []
    for (let node = el; node && node !== root; node = node.parentElement) {
      const tag = node.tagName.toLowerCase()
      const parent = node.parentElement || root
      const siblings = [...(parent.children || [node])].filter(item => item.tagName === node.tagName)
      const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''
      segments.unshift(tag + nth)
      if (node.parentElement?.id) {
        const parentId = `#${cssEscape(node.parentElement.id)}`
        if (root.querySelectorAll(parentId).length === 1) {
          segments.unshift(parentId)
          break
        }
      }
    }
    return segments.join(' > ')
  }

  function contexts(scopeItem) {
    const found = []
    function visit(root, steps, frames, depth, queryRoot = root) {
      found.push({ root, steps, frames, queryRoot })
      if (depth >= MAX_CONTEXT_DEPTH) { scanTruncated = true; return }
      const candidates = queryRoot.querySelectorAll('*')
      if (candidates.length > MAX_NODES_PER_CONTEXT) scanTruncated = true
      const nodes = [ ...(queryRoot.nodeType === 1 ? [queryRoot] : []), ...candidates ].slice(0, MAX_NODES_PER_CONTEXT)
      for (const node of nodes) {
        if (node.shadowRoot) visit(node.shadowRoot,
          [...steps, `shadow=${selectorFor(node, root)}`], frames, depth + 1)
        if (node.tagName === 'IFRAME') {
          try {
            if (node.contentDocument) visit(node.contentDocument,
              [...steps, `frame=${selectorFor(node, root)}`], [...frames, node], depth + 1)
          } catch { /* cross-origin frames are not readable from the top page */ }
        }
      }
    }
    if (scopeItem) visit(scopeItem.context.root, scopeItem.context.steps, scopeItem.context.frames, 0, scopeItem.el)
    else visit(document, [], [], 0)
    return found
  }

  function labelsOf(el) {
    const labels = [...(el.labels || [])].map(textOf)
    const labelledBy = trim(el.getAttribute('aria-labelledby')).split(/\s+/).filter(Boolean)
    const root = el.getRootNode()
    for (const id of labelledBy) {
      const label = root.getElementById?.(id) || el.ownerDocument.getElementById(id)
      if (label) labels.push(textOf(label))
    }
    const enclosing = el.closest('label')
    if (enclosing) labels.push(textOf(enclosing))
    return [...new Set(labels.filter(Boolean))]
  }

  function roleOf(el) {
    const explicit = trim(el.getAttribute('role'))
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea' || el.isContentEditable) return 'textbox'
    if (tag === 'input') {
      if (el.type === 'hidden') return ''
      if (['checkbox', 'radio', 'button', 'submit'].includes(el.type)) return el.type === 'submit' ? 'button' : el.type
      return 'textbox'
    }
    return ''
  }

  function valueOf(el) {
    if (['password', 'hidden'].includes(el.type)) return el.value ? '***' : ''
    if (el.isContentEditable) return el.innerText || el.textContent || ''
    return 'value' in el ? el.value : undefined
  }

  function describe(el, context) {
    const selector = selectorFor(el, context.root)
    return {
      locator: [...context.steps, `css=${selector}`].join(' >>> '),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      type: el.type || '',
      id: el.id || '',
      name: el.name || '',
      labels: labelsOf(el),
      placeholder: el.placeholder || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      text: textOf(el),
      href: el.href ? new URL(el.href, el.ownerDocument.location.href).pathname : '',
      value: valueOf(el),
      checked: 'checked' in el ? Boolean(el.checked) : undefined,
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      visible: visible(el),
      contentEditable: Boolean(el.isContentEditable),
      frameDepth: context.frames.length
    }
  }

  function allElements(scopeItem, selector = SELECTOR) {
    return contexts(scopeItem).flatMap(context => {
      const candidates = context.queryRoot.querySelectorAll(selector)
      if (candidates.length > MAX_NODES_PER_CONTEXT) scanTruncated = true
      const nodes = [...candidates].slice(0, MAX_NODES_PER_CONTEXT)
      if (context.queryRoot.nodeType === 1 && context.queryRoot.matches(selector)) nodes.unshift(context.queryRoot)
      return nodes.map(el => ({ el, context }))
    })
  }

  function explicitLocator(query) {
    if (!query.includes(' >>> ')) return null
    let root = document
    const frames = []
    const parts = query.split(' >>> ')
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      const separator = part.indexOf('=')
      if (separator < 1) throw new Error(`Invalid locator part: ${part}`)
      const kind = part.slice(0, separator)
      const selector = part.slice(separator + 1)
      const candidates = root.querySelectorAll(selector)
      if (candidates.length > 1) throw new Error(`Ambiguous locator segment: ${part}`)
      const el = candidates[0]
      if (!el) return null
      if (kind === 'frame') {
        if (el.tagName !== 'IFRAME' || !el.contentDocument) throw new Error('Frame is not same-origin or available')
        frames.push(el)
        root = el.contentDocument
      } else if (kind === 'shadow') {
        if (!el.shadowRoot) throw new Error('Shadow root is closed or unavailable')
        root = el.shadowRoot
      } else if (kind === 'css' && index === parts.length - 1) {
        return { el, context: { root, frames, steps: parts.slice(0, -1) } }
      } else throw new Error(`Invalid locator part: ${part}`)
    }
    throw new Error('Locator must end with css=')
  }

  function matches(item, kind, needle) {
    const d = describe(item.el, item.context)
    const fields = {
      label: d.labels,
      placeholder: [d.placeholder],
      role: [d.role],
      name: [d.name],
      id: [d.id],
      text: [d.text, d.ariaLabel],
      any: [d.text, d.ariaLabel, d.placeholder, d.name, d.id, d.role, ...d.labels]
    }[kind]
    return fields?.filter(Boolean).some(field => field.toLocaleLowerCase().includes(needle.toLocaleLowerCase()))
  }

  function search(query, limit = 100) {
    const raw = trim(query)
    const prefixed = /^(label|placeholder|role|name|id|text|css)=(.*)$/s.exec(raw)
    const kind = prefixed?.[1] || 'any'
    const needle = prefixed ? prefixed[2] : raw
    const items = allElements().filter(item => visible(item.el))
    let found
    if (kind === 'css') {
      found = contexts().flatMap(context => [...context.root.querySelectorAll(needle)].map(el => ({ el, context })))
    } else found = items.filter(item => matches(item, kind, needle))
    return { total: found.length, scanTruncated,
      matches: found.slice(0, Math.max(1, Math.min(Number(limit) || 100, 200))).map(item => describe(item.el, item.context)) }
  }

  function resolve(query, purpose = 'any') {
    const raw = trim(query)
    if (!raw) throw new Error('Target is required')
    const exact = explicitLocator(raw)
    if (exact) {
      if (!visible(exact.el)) throw new Error(`Visible element not found: ${raw}`)
      return exact
    }
    if (raw.includes(' >>> ')) throw new Error(`Locator segment not found: ${raw}`)
    const prefixed = /^(label|placeholder|role|name|id|text|css)=(.*)$/s.exec(raw)
    const kind = prefixed?.[1] || 'any'
    const needle = prefixed ? prefixed[2] : raw
    let found = []
    if (kind === 'css' || !prefixed) {
      try {
        found = contexts().flatMap(context => [...context.root.querySelectorAll(needle)].map(el => ({ el, context })))
      } catch { if (kind === 'css') throw new Error(`Invalid CSS selector: ${needle}`) }
    }
    if (!found.length && kind !== 'css') found = allElements().filter(item => matches(item, kind, needle))
    if (purpose === 'fill' || purpose === 'state') {
      const fields = found.filter(item => ['INPUT', 'TEXTAREA', 'SELECT'].includes(item.el.tagName) || item.el.isContentEditable)
      if (fields.length || purpose === 'fill') found = fields
    }
    found = found.filter(item => visible(item.el))
    if (!found.length) throw new Error(`Visible ${purpose === 'fill' ? 'editable ' : ''}element not found: ${raw}; try find`)
    const exactText = found.filter(item => {
      const d = describe(item.el, item.context)
      return [d.text, d.ariaLabel, d.placeholder, d.name, d.id, d.role, ...d.labels]
        .some(field => field.toLocaleLowerCase() === needle.toLocaleLowerCase())
    })
    if (exactText.length) found = exactText
    if (found.length > 1) throw new Error(`Ambiguous target (${found.length} matches): ${raw}; use find and its exact locator`)
    return found[0]
  }

  function state(target) {
    const { el, context } = resolve(target, 'state')
    const d = describe(el, context)
    const vueValues = []
    let node = el
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const vm = node.__vue__
      if (!vm) continue
      for (const candidate of [vm.value, vm.currentValue, vm.$props?.value, vm.$data?.currentValue]) {
        if (['string', 'number', 'boolean'].includes(typeof candidate) && !vueValues.includes(candidate)) vueValues.push(candidate)
      }
    }
    return {
      ...d,
      domValue: d.value,
      vueValues,
      modelValueObserved: vueValues.length > 0,
      modelMatchesDom: vueValues.length ? vueValues.some(candidate => String(candidate) === String(d.value)) : null,
      blankClassPresent: Boolean(el.closest('.basic-field-blank'))
    }
  }

  function fill(target, rawValue) {
    const { el, context } = resolve(target, 'fill')
    const value = String(rawValue ?? '')
    if (el.type === 'password' || el.type === 'file') throw new Error('Password and file inputs require direct user interaction')
    if (['checkbox', 'radio', 'button', 'submit', 'hidden', 'reset'].includes(el.type)) {
      throw new Error(`Use click for input type=${el.type}`)
    }
    if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') throw new Error('Element is disabled or read-only')
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.focus()
    if (el.tagName === 'SELECT') {
      const option = [...el.options].find(item => item.value === value || trim(item.textContent) === value)
      if (!option) throw new Error(`Select option not found: ${value}`)
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      if (setter) setter.call(el, option.value)
      else el.value = option.value
    } else if (el.isContentEditable) {
      if (el.querySelector('*')) throw new Error('Rich contenteditable markup requires a site-specific editor workflow')
      el.textContent = value
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      if (setter) setter.call(el, value)
      else el.value = value
      if (el.value !== value) throw new Error(`Browser rejected the value for input type=${el.type || 'text'}`)
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return state(describe(el, context).locator)
  }

  function blur(target) {
    const { el, context } = resolve(target, 'fill')
    el.dispatchEvent(new Event('change', { bubbles: true }))
    el.blur()
    return { blurred: true, domValue: valueOf(el), locator: describe(el, context).locator }
  }

  function point(target) {
    const { el, context } = resolve(target)
    el.scrollIntoView({ block: 'center', inline: 'center' })
    let rect = el.getBoundingClientRect()
    let x = rect.left + rect.width / 2
    let y = rect.top + rect.height / 2
    for (const frame of [...context.frames].reverse()) {
      frame.scrollIntoView({ block: 'center', inline: 'center' })
      rect = frame.getBoundingClientRect()
      x += rect.left + frame.clientLeft
      y += rect.top + frame.clientTop
    }
    return { x, y, tag: el.tagName, text: textOf(el), locator: describe(el, context).locator }
  }

  function snapshot(options) {
    if (options && Object.keys(options).length) return compactSnapshot(options)
    const elements = allElements().map(item => describe(item.el, item.context))
    const inputs = elements.filter(item => ['input', 'textarea', 'select'].includes(item.tag))
      .map((item, index) => ({ ...item, index }))
    const buttons = elements.filter(item => item.visible && ['button', 'link'].includes(item.role))
      .map((item, index) => ({ ...item, index }))
    return {
      title: document.title,
      ready: document.readyState,
      elements: elements.filter(item => item.visible).slice(0, 500),
      elementsCount: elements.length,
      scanTruncated,
      inputs: inputs.slice(0, 500),
      inputsCount: inputs.length,
      buttons: buttons.slice(0, 400),
      buttonsCount: buttons.length,
      bodyText: (document.body?.innerText || '').slice(0, 12000)
    }
  }

  function compactSnapshot(options) {
    if (Array.isArray(options) || typeof options !== 'object') throw new Error('Snapshot options must be an object')
    const optionNames = ['mode', 'scope', 'selector', 'fields', 'limit', 'captureLimit', 'textLimit',
      'includeValues', 'includeText', 'since', 'semanticScope', 'target']
    if (Object.keys(options).some(key => !optionNames.includes(key))) throw new Error('Unknown snapshot option')
    if (options.mode !== undefined && options.mode !== 'compact') throw new Error('Snapshot mode must be compact')
    for (const key of ['scope', 'selector', 'since']) {
      if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key].trim())) throw new Error(`${key} must be a non-empty string`)
    }
    for (const key of ['includeValues', 'includeText', 'semanticScope']) {
      if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be boolean`)
    }
    const limit = options.limit ?? 100
    const captureLimit = options.captureLimit ?? limit
    const textLimit = options.textLimit ?? 2000
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be an integer from 1 to 500')
    if (!Number.isInteger(captureLimit) || captureLimit < limit || captureLimit > 1000) throw new Error('captureLimit must be an integer from limit to 1000')
    if (!Number.isInteger(textLimit) || textLimit < 0 || textLimit > 12000) throw new Error('textLimit must be an integer from 0 to 12000')
    const allowed = ['locator', 'tag', 'role', 'type', 'id', 'name', 'labels', 'placeholder', 'ariaLabel', 'text', 'href', 'value', 'checked', 'disabled', 'visible', 'contentEditable', 'frameDepth']
    const fields = options.fields ?? ['locator', 'role', 'labels', 'text', 'checked', 'disabled', ...(options.includeValues ? ['value'] : [])]
    if (!Array.isArray(fields) || fields.some(field => !allowed.includes(field))) throw new Error('Unknown snapshot field')
    let scope = options.scope ? resolve(options.scope) : null
    if (scope && options.semanticScope) {
      const semantic = scope.el.closest('dialog,form,fieldset,tr,section,article,[role="dialog"],[role="alertdialog"],[role="row"]')
      if (semantic && semantic !== scope.el.ownerDocument.body) scope = { el: semantic, context: scope.context }
    }
    const items = allElements(scope, options.selector || SELECTOR).filter(item => visible(item.el))
    const selectedFields = [...new Set(['locator', ...fields])]
    const serialize = item => {
      const d = describe(item.el, item.context)
      // A compact structural read must not leak an input value through textOf's fallback.
      if (['input', 'textarea', 'select'].includes(d.tag) || d.contentEditable) d.text = ''
      return Object.fromEntries(selectedFields.filter(field => field !== 'value' || options.includeValues === true)
        .filter(field => d[field] !== undefined).map(field => [field, d[field]]))
    }
    const baselineElements = items.slice(0, captureLimit).map(serialize)
    const elements = baselineElements.slice(0, limit)
    const rawText = options.includeText === true ? (scope?.el || document.body)?.innerText || '' : ''
    return {
      title: document.title, ready: document.readyState, mode: 'compact',
      scope: scope ? describe(scope.el, scope.context).locator : null,
      elements, elementsCount: items.length, returnedCount: elements.length,
      baselineElements, truncated: scanTruncated || items.length > limit,
      baselineTruncated: scanTruncated || items.length > captureLimit, scanTruncated,
      ...(options.includeText === true ? { bodyText: rawText.slice(0, textLimit), textTruncated: rawText.length > textLimit } : {}),
      // Consumed by the worker for in-memory baseline isolation; never returned to the client.
      documentKey: `${performance.timeOrigin}:${location.href}`
    }
  }

  function conditionItems(target) {
    const raw = trim(target)
    if (!raw) throw new Error('Condition target is required')
    if (raw.includes(' >>> ')) {
      const item = explicitLocator(raw)
      return item ? [item] : []
    }
    const prefixed = /^(label|placeholder|role|name|id|text|css)=(.*)$/s.exec(raw)
    const kind = prefixed?.[1] || 'any'
    const needle = prefixed ? prefixed[2] : raw
    if (kind === 'css' || kind === 'any') {
      try {
        const found = allElements(null, needle)
        if (found.length || kind === 'css') return found
      } catch (error) { if (kind === 'css') throw error }
    }
    const found = allElements().filter(item => matches(item, kind, needle))
    const exact = found.filter(item => {
      const d = describe(item.el, item.context)
      return [d.text, d.ariaLabel, d.placeholder, d.name, d.id, d.role, ...d.labels]
        .some(field => field.toLocaleLowerCase() === needle.toLocaleLowerCase())
    })
    return exact.length ? exact : found
  }

  function clickablePoint(item) {
    const { el, context } = item
    if (!visible(el)) return { clickable: false, reason: 'hidden' }
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) {
      return { clickable: false, reason: 'disabled' }
    }
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const rect = el.getBoundingClientRect()
    let x = rect.left + rect.width / 2
    let y = rect.top + rect.height / 2
    const hits = (root, node, px, py) => {
      const hit = root.elementFromPoint(px, py)
      return hit === node || node.contains(hit)
    }
    let node = el
    while (true) {
      const root = node.getRootNode()
      if (!hits(root, node, x, y)) return { clickable: false, reason: 'covered', locator: describe(el, context).locator }
      if (!root.host) break
      node = root.host
    }
    const geometry = [[rect.x, rect.y, rect.width, rect.height]]
    for (const frame of [...context.frames].reverse()) {
      frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      const r = frame.getBoundingClientRect()
      // Transformed frames need a dedicated coordinate adapter; fail instead of guessing.
      if (frame.ownerDocument.defaultView.getComputedStyle(frame).transform !== 'none') return { clickable: false, reason: 'transformed_frame' }
      x += r.left + frame.clientLeft
      y += r.top + frame.clientTop
      geometry.push([r.x, r.y, r.width, r.height])
      node = frame
      while (true) {
        const root = node.getRootNode()
        if (!hits(root, node, x, y)) return { clickable: false, reason: 'covered_frame' }
        if (!root.host) break
        node = root.host
      }
    }
    return { clickable: true, x, y, geometry, locator: describe(el, context).locator }
  }

  function probe(options) {
    const condition = options.condition || 'visible'
    const supported = ['visible', 'hidden', 'attached', 'detached', 'enabled', 'disabled', 'clickable', 'value', 'text', 'checked', 'count']
    if (!supported.includes(condition)) throw new Error(`Unknown condition: ${condition}`)
    const items = conditionItems(options.target)
    if (scanTruncated) throw new Error('Condition scan was truncated; narrow the target with an explicit frame/shadow locator')
    if (condition === 'count') return { met: items.length === options.equals, actual: items.length }
    if (['visible', 'hidden', 'attached', 'detached'].includes(condition)) {
      const actual = { count: items.length, visibleCount: items.filter(item => visible(item.el)).length }
      if (condition === 'hidden') return { met: actual.visibleCount === 0, actual }
      if (condition === 'detached') return { met: actual.count === 0, actual }
      if (items.length > 1) throw new Error(`Ambiguous condition target (${items.length} matches); use an exact locator`)
      return { met: condition === 'visible' ? actual.visibleCount === 1 : actual.count === 1, actual }
    }
    if (items.length > 1) throw new Error(`Ambiguous condition target (${items.length} matches); use an exact locator`)
    if (!items.length) return { met: false, actual: { count: 0 } }
    const { el } = items[0]
    if (['password', 'hidden'].includes(el.type) && ['value', 'text'].includes(condition)) throw new Error('Conditions cannot inspect password or hidden values')
    if (condition === 'clickable') {
      const actual = clickablePoint(items[0])
      return { met: actual.clickable, actual }
    }
    let actual
    if (condition === 'enabled' || condition === 'disabled') {
      actual = Boolean(el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]'))
      return { met: visible(el) && (condition === 'disabled' ? actual : !actual), actual: { disabled: actual } }
    }
    if (condition === 'value') actual = valueOf(el)
    if (condition === 'text') actual = trim(el.innerText || el.textContent)
    if (condition === 'checked') actual = 'checked' in el ? Boolean(el.checked) : el.getAttribute('aria-checked') === 'true'
    const met = options.includes !== undefined ? String(actual ?? '').includes(options.includes) : actual === options.equals
    return { met, actual: typeof actual === 'string' ? actual.slice(0, 1000) : actual }
  }

  function guide() {
    const items = allElements().filter(item => visible(item.el))
    const groups = new Map()
    const entries = []
    for (const item of items) {
      const d = describe(item.el, item.context)
      const isField = ['input', 'textarea', 'select'].includes(d.tag) || d.contentEditable ||
        ['textbox', 'combobox', 'checkbox', 'radio', 'switch'].includes(d.role)
      if (isField && d.type !== 'hidden') {
        const form = item.el.closest('form')
        const contextPrefix = item.context.steps.join(' >>> ')
        const formKey = form ? `form:${selectorFor(form, item.context.root)}` : 'page'
        const group = [contextPrefix, formKey].filter(Boolean).join(' >>> ')
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group).push({ label: d.labels[0] || d.ariaLabel || d.placeholder || d.name || d.id || d.role,
          role: d.role, type: d.type, locator: d.locator, required: Boolean(item.el.required || item.el.getAttribute('aria-required') === 'true') })
      }
      if (['a', 'button', 'summary'].includes(d.tag) || ['link', 'button', 'menuitem', 'tab'].includes(d.role)) {
        const label = d.ariaLabel || d.text || d.labels[0]
        if (!label) continue
        const container = item.el.closest('nav,header,aside,[role="navigation"],[role="menu"]')
        entries.push({ label: label.slice(0, 100), role: d.role, location: container ? 'navigation' : 'page',
          locator: d.locator, hrefPath: d.href })
      }
    }
    entries.sort((a, b) => Number(b.location === 'navigation') - Number(a.location === 'navigation'))
    return {
      forms: [...groups].slice(0, 20).map(([group, fields]) => ({ group, fields: fields.slice(0, 80), fieldsCount: fields.length })),
      entries: entries.slice(0, 80),
      entriesCount: entries.length,
      scanTruncated,
      note: 'Structural hints only; verify current page before actions. No field values are included.'
    }
  }

  return { search, state, fill, blur, point, snapshot, guide, probe }
}
