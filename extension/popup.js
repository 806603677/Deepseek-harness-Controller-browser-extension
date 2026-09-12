import { normalizeAccessPolicy, permissionPatterns } from './allowed-origins.js'

const statusElement = document.getElementById('status')
const tabsElement = document.getElementById('tabs')
const errorElement = document.getElementById('error')
const originsElement = document.getElementById('origins')
let settingsLoaded = false

function request(method, params = {}) {
  return chrome.runtime.sendMessage({ channel: 'popup', method, params }).then(response => {
    if (!response?.ok) throw new Error(response?.error || '扩展后台未响应')
    return response.result
  })
}

function button(text, className, onClick) {
  const element = document.createElement('button')
  element.textContent = text
  if (className) element.className = className
  element.addEventListener('click', async () => {
    element.disabled = true
    errorElement.textContent = ''
    try {
      await onClick()
      await refresh()
    } catch (error) {
      errorElement.textContent = error.message
    } finally {
      element.disabled = false
    }
  })
  return element
}

async function refresh() {
  errorElement.textContent = ''
  const [status, tabs] = await Promise.all([request('status'), request('list')])
  if (!settingsLoaded) {
    document.querySelector(`input[name="accessMode"][value="${status.accessPolicy.mode}"]`).checked = true
    originsElement.value = status.accessPolicy.origins.join('\n')
    settingsLoaded = true
  }
  statusElement.textContent = status.nativeHostConnected
    ? `Native Host 已连接；已接管 ${status.claimedTabIds.length} 个页面`
    : 'Native Host 未连接，请先运行 install.ps1 后重新加载扩展'
  tabsElement.replaceChildren()

  if (!tabs.length) {
    tabsElement.textContent = '当前没有打开的已授权网站页面；先配置并保存访问范围。'
    return
  }

  for (const tab of tabs) {
    const row = document.createElement('div')
    row.className = 'tab'
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = `${tab.title || '未命名页面'}（Tab ${tab.id}）`
    const url = document.createElement('div')
    url.className = 'url'
    url.textContent = tab.url
    row.append(title, url)
    row.append(tab.claimed
      ? button('释放', 'release', () => request('release', { tabId: tab.id }))
      : button('交给 DSH', '', () => request('claim', { tabId: tab.id })))
    tabsElement.append(row)
  }
}

document.getElementById('saveAccess').addEventListener('click', async event => {
  const button = event.currentTarget
  errorElement.textContent = ''
  try {
    const mode = document.querySelector('input[name="accessMode"]:checked').value
    const policy = normalizeAccessPolicy({
      mode,
      origins: originsElement.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    })
    // Must be called directly from the popup click; native clients cannot grant themselves sites.
    const patterns = permissionPatterns(policy)
    if (patterns.length && !await chrome.permissions.request({ origins: patterns })) {
      throw new Error('浏览器权限未获批准；访问范围未改变')
    }
    button.disabled = true
    await request('set_access_policy', { policy })
    settingsLoaded = false
    await refresh()
  } catch (error) {
    errorElement.textContent = error.message
  } finally {
    button.disabled = false
  }
})

document.getElementById('refresh').addEventListener('click', () => refresh().catch(error => { errorElement.textContent = error.message }))
document.getElementById('releaseAll').addEventListener('click', () => request('release_all').then(refresh).catch(error => { errorElement.textContent = error.message }))
refresh().catch(error => { errorElement.textContent = error.message })
