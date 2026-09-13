# DSH Browser Controller (Edge / Windows Chrome)

这是供 DSH 或其他可执行本地命令的智能体使用的**本机浏览器桥接组件**，不是 Codex 插件或独立的 iOS App。它连接用户已打开的桌面浏览器标签，不要求以 `--remote-debugging-port` 启动浏览器。

本仓库 `Deepseek-harness-Controller-browser-extension` 主要针对 DeepSeek Harness 优化；其他 Harness 可参考本机命令接口适配，但尚未完成端到端兼容验证。

若要让 Agent 为不同网站建立精简的表单/入口 Memory，并在重复工作值得流程化时征询用户，请看 [独立 Agent 示范工程](examples/agent-workspace/SETUP.md)。插件只给页面结构和流程建议，不自动写 Memory 或 Skill。

```text
智能体的本地命令工具 → Node.js 客户端 → 当前 Windows 用户的 Named Pipe
  → Native Messaging Host → Edge/Chrome 扩展 → 已接管标签的 chrome.debugger/CDP
```

若 DSH 沙箱不允许访问 Named Pipe，客户端在 `auto` 模式下回退到本地 `runtime/` 文件信箱。所有控制操作只针对浏览器“网站访问权限”当前允许、且控制器已启用的网页；用户仍须接管具体标签。网站权限**不等于**允许智能体自行保存、提交或修改业务数据。

## 获取、放置和依赖

- Fork / clone 仓库后，**克隆目录本身**就是组件根目录；默认目录名可能是 `Deepseek-harness-Controller-browser-extension`，也可以克隆到自定的 `dsh-edge-controller` 目录。若另行取得 `dsh-edge-controller-source-0.9.0.zip`，ZIP 内的 `dsh-edge-controller/` 才是组件根目录。不要只复制 `extension/`，否则 DSH 无法调用客户端和宿主。
- Windows 10/11、桌面 Microsoft Edge 或 Google Chrome、PowerShell、Node.js（建议 18+）、Windows .NET Framework 4.x 的 `csc.exe`。安装脚本会在每台机器上本地编译 C# 宿主；**不分发本机编译好的 EXE**。无编译器时请在该机器上安装相应 .NET Framework 开发工具，再运行安装脚本。
- 别在打包后移动组件目录：Native Host 的注册表配置记录了本机绝对路径。移动后重新运行安装脚本。安装仅修改当前 Windows 用户的对应浏览器 Native Messaging 注册表键，不需要管理员权限。
- `runtime/`、`native-host/bin/`、`dist/` 和本机生成的宿主清单不在源码包内。不要把这些文件提交到公开 fork；旧版 `native-host/com.dsh.edge.json` 若存在，也不用于新安装。

## 在 Edge 安装并启用

1. 打开 `edge://extensions`，打开“开发人员模式”，选择“加载解压缩的扩展”，**选择组件根目录下的 `extension` 文件夹**（不是 ZIP、仓库根目录或 `native-host`）。
2. 确认扩展已启用，复制扩展卡片上的 32 位 ID。在普通 PowerShell 中运行（替换示例路径和 ID）：

   ```powershell
   Set-Location 'C:\Tools\my-fork\dsh-edge-controller'
   .\install.ps1 -Browser Edge -ExtensionId '<扩展卡片上的32位ID>'
   ```

3. 回 `edge://extensions` 点扩展卡片的“重新加载”，打开本扩展“详细信息”，在“网站访问权限”选择“单击时”“在特定站点上”或“在所有站点上”。若选特定站点，使用浏览器的“添加站点”输入框添加目标网站。将扩展固定到工具栏，在弹窗中点“启用控制器”，再打开目标页面，点“交给 DSH”。浏览器的调试提示及标签上的 `DSH` 徽标是接管提示。
4. 如果 Native Host 未连接，确认安装脚本显示的宿主 EXE 与清单均存在、扩展 ID 精确一致，并重新加载扩展。企业策略可能禁止扩展、Native Messaging 或调试器。

## 网站访问范围（使用者自行决定）

新安装及从旧版升级后，控制器默认**未启用**。先在扩展管理页的“网站访问权限”选择浏览器提供的模式，再在扩展弹窗中启用控制器：

- “单击时”：在目标页面点击扩展图标后，浏览器临时允许该页面；随后在弹窗中接管标签。离开授权范围后需重新授予。
- “在特定站点上”：通过浏览器的“添加站点”输入框添加目标网站；只有浏览器授予的网站可被列出和接管。优先使用此模式。
- “在所有站点上”：浏览器允许扩展访问普通 HTTP/HTTPS 网站，但控制器仍只操作已接管的标签。不支持 `file:`、`chrome:`、`edge:` 等页面。

控制器每次操作前都检查浏览器实际授予的当前来源权限，不能通过 Native Host 修改网站访问模式。若浏览器收回权限或标签转到未授权网站，控制器会释放标签。弹窗的“暂停控制器”会立即释放全部标签并阻止新的接管；旧版弹窗保存的网站名单不再使用。浏览器可能在升级扩展后显示广泛的网站权限，因此**先核对并收窄浏览器设置，再启用控制器**。

此扩展拥有 `debugger` 权限，获用户授权的网页可能包含敏感数据。请勿在共享机器上开放所有网站，也不要把 `runtime/` 共享给他人。URL 输出会遮蔽常见令牌参数，密码输入被阻止，明显的 Cookie/Storage 读取脚本被阻止；**这些过滤不是完整的数据防泄漏沙箱**，只将控制权交给可信智能体。

## 让其他 DSH 智能体调用

DSH 的预设、工作目录和 shell 工具名称可能不同，不要假定固定的 DSH 内置插件语法。给智能体提供组件根目录的**本机绝对路径**，让它用其实际可用的本地命令工具调用脚本；能执行 Node.js 和访问当前用户的桥接通道即可。一个可直接加入项目说明/智能体提示的示例：

> 浏览器控制器位于 `C:\Tools\my-fork\dsh-edge-controller`。先用本地命令运行 `node "C:\Tools\my-fork\dsh-edge-controller\scripts\dsh-edge.mjs" status` 和 `list`，只从列表中选择用户已授权的准确 tabId。若未接管，确认用户已在浏览器扩展管理页授予网站访问权限、在弹窗启用控制器，再 `claim <tabId>`。先用 `find` 按标签、占位符、角色或文字找字段；从返回结果复制精确 `locator` 再操作。网页操作必须以当前页面内容验证；修改/保存/提交业务数据须先获得用户针对具体范围的授权。命令失败时报告错误，不要改用不受控的浏览器会话或猜测 tabId。

在组件目录下演示（在其他目录运行时请使用上述绝对脚本路径）：

```powershell
node .\scripts\dsh-edge.mjs status
node .\scripts\dsh-edge.mjs list
node .\scripts\dsh-edge.mjs claim <tabId>
node .\scripts\dsh-edge.mjs dom <tabId>
node .\scripts\dsh-edge.mjs find 'label=Full name' <tabId>
node .\scripts\dsh-edge.mjs find 'placeholder=Type a name' <tabId>
node .\scripts\dsh-edge.mjs guide <tabId>
node .\scripts\dsh-edge.mjs text <tabId>
node .\scripts\dsh-edge.mjs value 'input[name="example"]' <tabId>
node .\scripts\dsh-edge.mjs shot .\page.png <tabId>
node .\scripts\dsh-edge.mjs release <tabId>
```

还有 `click`、`fill`、`blur`、`fill-enter`、`key`、`reload`、`eval`、`eval-file`、`sequence`、`sequence-json`、`nav`、`new`、`release-all`。运行 `node .\scripts\dsh-edge.mjs` 查看完整参数；显式 tabId 最可靠。仅有一个已接管标签时可省略 tabId；多个时必须指定。`sequence` JSON 是最多 50 项、绑定同一标签的步骤数组：

```json
[
  { "action": "click", "target": "input[name='example']" },
  { "action": "fill", "target": "input[name='example']", "value": "test" },
  { "action": "value", "target": "input[name='example']" }
]
```

## 跨网站字段定位与边界

要先做网页结构说明，可运行 `guide <tabId>`：它返回当前来源、路径模板、可见表单字段的标签/角色/定位器和主要功能入口，不包含表单字段值；在动态页面上需再次核对。它不会自己创建 Memory。示范工程的 `site-context.mjs` 将每个来源、每个路径分别路由到对应 Memory；切站或换页时提示 Agent 清除旧页面假设。若需要判断是否值得把已验证的重复工作升级为精简流程，按 [示范工程设置说明](examples/agent-workspace/SETUP.md) 准备证据 JSON，再运行 `advise <evidence.json> <tabId>`。建议只依据已完成、已验证的次数，不把“反复打开过网页”算作成功流程。`advise` 仅给成本/收益判断；用户明确同意前不得写入站点 Skill。慢模型尤其应缩小 Skill，避免阅读成本超过操作节省时间。

`dom` 现在返回通用 `elements` 清单（含标签、ARIA 角色、占位符、可编辑状态和可复用的 `locator`），同时保留旧版 `inputs`、`buttons` 字段。`find` 可搜索 `label=...`、`placeholder=...`、`role=...`、`name=...`、`id=...`、`text=...` 或 `css=...`；不加前缀时优先按 CSS，再按上述文字线索搜索。搜索结果会列出精确 `locator`，适用于 `click`、`fill`、`value`、`blur` 和 `sequence` 的 `target`。若返回 `scanTruncated: true`，说明页面过大、通用扫描未覆盖全部节点，应改用精确 CSS 或页面专用脚本。 例如：

```powershell
node .\scripts\dsh-edge.mjs find 'label=Full name' <tabId>
node .\scripts\dsh-edge.mjs fill 'css=#person-name' 'Alice' <tabId>
node .\scripts\dsh-edge.mjs value 'css=#person-name' <tabId>
```

新定位器可深入**开放式 Shadow DOM** 和**同源 iframe**，例如 `shadow=#host >>> css=#field`、`frame=#form-frame >>> css=#field`。多个元素同名时不会猜一个：先 `find`，再复制结果里的完整定位器。`fill` 支持普通文本框、原生下拉框（可用选项值或可见文字）及简单 `contenteditable`；复选框、单选框应使用 `click`，密码和文件输入需用户直接处理。旧版 Vue 模型观察值仍附在 `value` 结果中，但只是 EDC 等 Vue 页面上的附加诊断，不再是跨网站定位或填写的必要条件。

这不是所有网页控件的万能适配器：跨域 iframe、闭合式 Shadow DOM、Canvas 绘制控件和某些富文本编辑器不能靠普通 DOM 定位；复杂框架可能拒绝合成输入事件。动态页面的结构定位器也可能随页面更新而失效。遇到这些情况应重新 `find` 并核对回读，必要时使用经审查的页面专用脚本；不要把“DOM 值已变”当成网站已持久化保存。

如果 DSH 沙箱不能连接 Pipe，`auto` 会尝试文件信箱；可设置 `$env:DSH_EDGE_TRANSPORT='file'` 强制文件模式，或 `'pipe'` 强制 Pipe 模式。Native Host 和 DSH 必须访问**同一个本地目录及当前 Windows 用户会话**。`status` 的 `clientTransport` 会报告实际通信方式；`list` 成功、已接管标签的 `dom` 成功才证明端到端可用。查看 DOM 不等于真实保存成功，保存后的回读需另外验证。

## Chrome 桌面与 iOS 可行性

- **Windows 桌面 Chrome：提供安装路径，待独立实机验证。** 在 `chrome://extensions` 以同样方式加载 `extension/`，复制 Chrome 显示的扩展 ID，运行 `.\install.ps1 -Browser Chrome -ExtensionId '<Chrome扩展ID>'`，重新加载，在扩展“详细信息 / 网站访问权限”选择模式并添加所需站点，然后在弹窗启用控制器。脚本写入当前用户的 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.edge`，与 Edge 的注册分开。两种浏览器若同时运行，当前版本共享同一个 Pipe 和 `runtime/`，**不保证请求路由到预期浏览器**；请只启用一个浏览器的本组件。没有在真实 Chrome 会话里做端到端控制测试，不能宣称已验证兼容。
- **iOS Chrome：不能直接加载本桌面扩展**。**iOS Safari：有移植方向，但不是解压或安装此包即可使用**。需要按 Safari Web Extension 的分发机制重新打包，并以 iOS 原生 App Extension/消息链路替换 Windows EXE、注册表、Named Pipe；还需重新设计 `chrome.debugger`/CDP 依赖和智能体在设备上的接入方式。本站点策略和部分 UI/协议代码可作为设计参考，当前没有 iOS 构建或实机验证。

相关官方资料：[Chrome 网站权限](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[Edge Native Messaging](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)、[Chrome 移动设备扩展限制](https://support.google.com/chrome_webstore/answer/1698338)、[Safari Web Extension 分发](https://developer.apple.com/documentation/safariservices/packaging-and-distributing-safari-web-extensions-with-app-store-connect)、[Safari 原生消息](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)。

## 测试、打包及卸载

```powershell
node .\tests\allowed-origins.mjs
node .\tests\access-policy-worker.mjs
node .\tests\workflow-advice.mjs
node .\tests\site-context-isolation.mjs
node .\tests\example-skill-layout.mjs
.\native-host\build.ps1
node .\tests\bridge-roundtrip.mjs
.\package.ps1
.\uninstall.ps1 -Browser Edge   # 或 Chrome；只删除该浏览器当前用户的注册项
```

若要自己验证跨网站定位，可运行 `node .\tests\fixture-server.mjs`，在 Edge/Chrome 打开其打印的本地 URL，将该 URL 的来源加入扩展允许名单，接管标签后执行 `find 'label=Full name'`、`find 'label=Shadow field'` 和 `find 'label=Frame field'`。测试页只含虚构字段。开发时的页面工具检查已覆盖普通输入框、原生下拉框、简单可编辑区域、开放式 Shadow DOM、同源 iframe 和隐藏值遮蔽；正式扩展在真实第三方网站上的表现仍须逐站验证。

`package.ps1` 输出 `dist/dsh-edge-controller-source-0.9.0.zip`，只包含源码、MIT 许可证、安装脚本、示范工程、测试页面和说明；已有同名 ZIP 会拒绝覆盖。包中的使用者仍须在各自机器上加载扩展并运行安装脚本。卸载不删除扩展或组件目录；浏览器扩展须在对应扩展管理页面另行移除。项目采用 [MIT 许可证](LICENSE)，版权署名为 Lewis。
