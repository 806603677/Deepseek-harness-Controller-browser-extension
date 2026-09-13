const statusElement = document.getElementById('status')
const tabsElement = document.getElementById('tabs')
const errorElement = document.getElementById('error')
const toggleAccessElement = document.getElementById('toggleAccess')
let browserAccessEnabled = false

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
  browserAccessEnabled = status.browserAccessEnabled
  toggleAccessElement.textContent = browserAccessEnabled ? '暂停控制器' : '启用控制器'
  statusElement.textContent = status.nativeHostConnected
    ? `Native Host 已连接；控制器${browserAccessEnabled ? '已启用' : '未启用'}；已接管 ${status.claimedTabIds.length} 个页面`
    : 'Native Host 未连接，请先运行 install.ps1 后重新加载扩展'
  tabsElement.replaceChildren()

  if (!tabs.length) {
    tabsElement.textContent = browserAccessEnabled
      ? '当前没有浏览器已授权的网站页面；请检查扩展详细信息中的网站访问权限。'
      : '先在扩展详细信息中配置网站访问权限，再启用控制器。'
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

toggleAccessElement.addEventListener('click', async () => {
  errorElement.textContent = ''
  toggleAccessElement.disabled = true
  try {
    await request('set_browser_access_enabled', { enabled: !browserAccessEnabled })
    await refresh()
  } catch (error) {
    errorElement.textContent = error.message
  } finally {
    toggleAccessElement.disabled = false
  }
})

document.getElementById('refresh').addEventListener('click', () => refresh().catch(error => { errorElement.textContent = error.message }))
document.getElementById('releaseAll').addEventListener('click', () => request('release_all').then(refresh).catch(error => { errorElement.textContent = error.message }))
refresh().catch(error => { errorElement.textContent = error.message })
