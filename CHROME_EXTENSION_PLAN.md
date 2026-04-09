# ClockBot Chrome Extension 方案

## 1. 目标

本方案的目标是让 `ClockBot` 在不破坏用户日常 `Chrome` 环境的前提下，完成 `IEYASU` 的自动打卡。

必须同时满足以下条件：

- 使用用户日常正在使用的 `Chrome profile`
- 不再修改、复制、包装、链接 `Chrome User Data`
- 不依赖 `Playwright` 去控制默认 `Chrome profile`
- 比 `Power Automate Desktop` 更通用、更可移植
- 继续保留 `ClockBot` 现有的桌面端配置、计划任务、日志能力

## 2. 现状问题

当前已经验证过几条路径：

- `Playwright + 真实 Chrome 默认 profile`
  - Chrome 会限制默认 `user data dir` 的远程调试
- `Playwright + wrapper/junction`
  - 会污染或破坏用户真实的 Chrome profile
  - 已出现 Chrome Google 账号登录状态丢失
- `PAD`
  - 能工作
  - 但依赖本机 UI 环境，移植性较差

结论：

如果需求是“必须使用用户日常 Chrome profile”，就不应该继续走 `Playwright` 或 profile 包装方案。

## 3. 推荐架构

推荐采用：

`Electron 桌面端 + Chrome Extension + localhost 通信`

职责拆分如下：

- `ClockBot Electron`
  - 设置管理
  - 时间计划
  - 手动触发
  - 日志展示
  - 本地通信服务
  - 执行结果状态管理
- `Chrome Extension`
  - 运行在用户真实的日常 Chrome 中
  - 打开或定位 IEYASU 页面
  - 检测页面状态
  - 点击登录/打卡相关控件
  - 将执行结果回传给 ClockBot

## 4. 为什么扩展方案适合这个需求

扩展运行在用户真实的 Chrome 实例里，因此天然具备以下特点：

- 使用的就是用户当前 Chrome profile
- 保留 Chrome 自己的 Google 账号登录状态
- 保留用户已有 cookie、书签、同步、扩展和页面会话
- 不需要 `DevTools remote debugging`
- 不需要 `userDataDir` 包装
- 不需要复制 profile

也就是说，扩展方案不会再碰当前这次已经踩到的问题根源。

## 5. 总体执行流程

### 5.1 手动执行流程

1. 用户在 `ClockBot` 中点击 `Clock In` 或 `Clock Out`
2. `ClockBot` 检查本地扩展连接状态
3. `ClockBot` 通过本地接口向扩展发送命令
4. 扩展检查是否已有 `IEYASU` 标签页
5. 如果没有，扩展新开一个 IEYASU 页面
6. 扩展等待页面加载并注入内容脚本
7. 内容脚本检查当前页面状态
8. 若需要登录，则使用页面内登录表单进行登录
9. 找到对应按钮并点击
10. 扩展将执行结果回传给 `ClockBot`
11. `ClockBot` 更新日志和 UI 状态

### 5.2 定时执行流程

1. `ClockBot` 到达计划时间
2. `ClockBot` 检查扩展是否在线
3. 在线则直接下发任务
4. 不在线则尝试提示用户打开 Chrome
5. 扩展执行页面操作并回传状态
6. `ClockBot` 写入当日结果

## 6. 模块设计

## 6.1 Electron 端

建议新增一个服务：

- `src/services/extension-bridge-service.js`

职责：

- 启动本地 `HTTP` 或 `WebSocket` 服务
- 管理扩展连接状态
- 向扩展发送执行命令
- 接收扩展回传的日志与执行结果
- 将结果映射到现有 `main.js` 和 `punch-service.js`

建议继续沿用现有：

- `settings-service.js`
- `scheduler-service.js`
- `log-service.js`
- `main.js`
- `punch-service.js`

但 `punch-service.js` 的浏览器自动化执行分支需要替换成：

- `performExtensionAttendanceAction(...)`

而不是：

- `performAttendanceAction(...)` 的 Playwright 版本

## 6.2 Chrome Extension 端

建议新增目录：

`browser-extension/`

建议结构：

```text
browser-extension/
  manifest.json
  background.js
  content-script.js
  page-automation.js
  icons/
```

职责拆分：

- `manifest.json`
  - 声明权限、host permissions、background、content scripts
- `background.js`
  - 与 ClockBot 本地服务通信
  - 负责创建/查找 IEYASU 标签页
  - 向标签页注入脚本
  - 接收执行结果
- `content-script.js`
  - 运行在 IEYASU 页面
  - 读取 DOM
  - 识别登录表单、打卡按钮、错误状态
- `page-automation.js`
  - 页面内纯业务逻辑
  - 便于后续抽离和测试

## 7. 通信方案

第一版推荐使用：

`127.0.0.1 HTTP + 轮询/短连接`

原因：

- 比 `Native Messaging` 更容易实现
- 调试简单
- 便于 Electron 端快速接入
- 不需要先处理浏览器原生宿主注册

### 7.1 Electron 作为本地服务端

建议监听：

`127.0.0.1:38473`

建议接口：

- `GET /health`
  - 扩展检查本地程序是否在线
- `GET /extension/status`
  - 扩展获取当前基础配置
- `POST /extension/result`
  - 扩展上报执行结果
- `POST /extension/log`
  - 扩展上报日志
- `POST /run`
  - 桌面端内部触发任务时可进入统一流程
- `GET /next-command`
  - 扩展轮询获取待执行任务

### 7.2 第一版通信模型

扩展每 2 秒轮询一次：

- `GET /next-command?clientId=...`

返回示例：

```json
{
  "commandId": "run-20260407-195800-clockout",
  "action": "clockOut",
  "attendanceUrl": "https://f.ieyasu.co/fointl/login",
  "credentials": {
    "username": "user",
    "password": "secret"
  }
}
```

无任务时：

```json
{
  "commandId": null
}
```

执行完成后，扩展回传：

```json
{
  "commandId": "run-20260407-195800-clockout",
  "status": "Success",
  "message": "Clock Out completed successfully.",
  "pageUrl": "https://f.ieyasu.co/timestamp"
}
```

## 8. 页面自动化设计

内容脚本负责处理下面几类状态：

- 当前未登录
- 当前已登录但未到打卡页
- 当前已在打卡页
- 当前按钮已不可用
- 页面提示定位失败
- 页面出现错误信息

建议保留并迁移当前 `Playwright` 版本中已验证过的逻辑：

- 登录按钮识别
- `Clock In / Clock Out` 按钮识别
- 可见控件过滤
- 打卡后状态确认
- 定位失败文案识别

这些逻辑已经有相当一部分存在于：

- `src/services/ieyasu-automation.js`

后续可以抽成纯函数后复用到扩展中。

## 8.1 交互层级选择

本方案默认直接使用增强层，不再以简单 DOM `click()` 作为主路径。

也就是说，首版实现就按下面的交互策略设计：

- 使用 `chrome.debugger`
- 通过 Chrome DevTools Protocol 发送更底层的输入事件
- 加入拟人化等待、移动轨迹、逐字输入、悬停和点击偏移

这样做的目标是让自动化行为尽量接近真实浏览器交互，而不是“脚本瞬移 + 直接 click”。

## 8.2 增强层实现思路

增强层建议采用：

- `background.js` 挂接目标标签页的 `chrome.debugger`
- 使用 DevTools Protocol 的 `Input` 域发送事件

建议使用的事件类型：

- `Input.dispatchMouseEvent`
  - `mouseMoved`
  - `mousePressed`
  - `mouseReleased`
- `Input.dispatchKeyEvent`
  - `keyDown`
  - `char`
  - `keyUp`

建议的交互效果：

- 打开页面后先等待一个随机短延迟
- 将目标输入框滚动到合适位置
- 让鼠标轨迹分多步移动到输入框附近
- 先悬停，再点击，再输入
- 用户名和密码逐字输入，字符间带随机停顿
- 输入完成后再等待一个短延迟
- 鼠标移动到登录按钮区域，并在按钮内部随机落点点击
- 进入打卡页后重复类似过程点击 `Clock In / Clock Out`

## 8.3 拟人化策略

建议直接内置一组基础拟人化参数：

- 操作前等待：`200ms - 900ms`
- 字符输入间隔：`40ms - 180ms`
- 点击前悬停：`150ms - 600ms`
- 按钮点击偏移：按钮可点击区域内随机点
- 鼠标移动轨迹：分段插值，而不是一步到位

可以进一步加入：

- 偶发性更长停顿
- 输入错误后退格再重输
- 页面滚动时加入小幅超调

但第一版不建议把行为做得过于复杂，以免影响稳定性。

## 8.4 需要说明的边界

即使使用增强层，这种方式仍然是：

- 真实浏览器内的低层输入模拟

它比普通 DOM `click()` 更接近真实用户操作，但仍然不是：

- Windows 系统级真实鼠标指针移动

所以它比 `PAD` 更像用户操作，但不等于完全复刻系统鼠标。

## 9. Chrome 启动策略

这里要注意：扩展方案的重点不是“由 ClockBot 造出一个特殊的 Chrome”，而是“使用用户本来就在用的 Chrome”。

因此建议：

- 如果 Chrome 已打开，直接复用当前实例
- 如果 Chrome 未打开，使用普通方式启动 Chrome
- 不传 `user-data-dir`
- 不传 profile 重定向参数
- 不使用 wrapper/junction

也就是说，启动策略必须保持“像用户自己双击 Chrome 一样”。

## 10. 安全与隐私

### 10.1 本地服务

- 仅监听 `127.0.0.1`
- 不监听外网地址
- 可增加一次性 token 校验

### 10.2 凭据

- 继续沿用桌面端现有的安全存储
- 扩展不长期存储 IEYASU 凭据
- 扩展只在执行时从桌面端拿临时任务数据

### 10.3 扩展权限

建议首版权限：

- `tabs`
- `scripting`
- `storage`
- `activeTab`
- `debugger`

host permissions：

- `https://*.ieyasu.co/*`

如果后续本地通信改成 fetch 请求，还需允许：

- `http://127.0.0.1/*`

## 11. 兼容性

该方案的可移植性明显高于 `PAD`，但仍有几个前提：

- 机器上安装了 Chrome
- 用户安装了 ClockBot 扩展
- Chrome 允许扩展运行
- 本地程序在线

相比之下，这些前提远比 `PAD` 的 UI 环境依赖更容易标准化。

## 12. 迁移策略

建议分阶段迁移，不要一步全部替换。

### Phase 1

先做最小可运行版本：

- Electron 本地服务
- Chrome 扩展安装
- 扩展连接状态显示
- 手动 `Clock In / Clock Out`
- `chrome.debugger` 驱动的增强层输入

目标：

- 先跑通“用户真实 Chrome profile + IEYASU 页面点击”

### Phase 2

补齐定时执行：

- Scheduler 与扩展通信
- 扩展轮询任务
- 结果回传到 Electron UI

### Phase 3

补齐稳定性与可观测性：

- 更详细日志
- 重试机制
- 页面异常状态识别
- Chrome 未打开时的引导

### Phase 4

逐步下线旧实现：

- 移除 `Playwright` 真实 profile 相关逻辑
- 移除 wrapper/junction
- 将 `PAD` 保留为 fallback 或开发期开关

## 13. 对当前项目的直接改造点

建议新增：

- `src/services/extension-bridge-service.js`
- `src/services/extension-attendance.js`
- `browser-extension/manifest.json`
- `browser-extension/background.js`
- `browser-extension/content-script.js`
- `browser-extension/page-automation.js`

建议调整：

- `src/services/punch-service.js`
  - 浏览器模式从 Playwright 切到扩展桥接
- `src/main.js`
  - 增加扩展连接状态
  - 增加扩展服务启动
- `src/renderer/app.js`
  - 增加扩展在线状态提示
- `src/renderer/index.html`
  - 增加“Chrome Extension Connected / Not Connected”提示

建议废弃：

- 当前针对真实 Chrome profile 的 wrapper/junction 逻辑
- IEYASU session snapshot 逻辑

## 14. 风险与注意点

### 14.1 Chrome 扩展安装成本

第一次使用时需要安装扩展。

### 14.2 企业环境策略

部分机器可能限制扩展安装或 localhost 通信。

### 14.3 页面结构变化

IEYASU DOM 改版时，扩展的内容脚本仍需要维护。

但这类维护成本仍然通常低于 `PAD`。

## 15. 推荐结论

如果需求优先级是：

- 必须使用真实日常 Chrome profile
- 不希望破坏 Chrome 自己的 Google 登录状态
- 希望比 PAD 更通用

那么推荐路线就是：

`停止 Playwright 复用真实 profile`  
`改做 Chrome Extension 模式`

这是当前最符合目标、风险最低、长期也最容易维护的方案。

## 16. 建议的下一步

下一步建议直接进入 PoC 阶段，只做最小闭环：

1. Electron 启动一个本地 `127.0.0.1` 服务
2. Chrome Extension 轮询本地服务
3. 点击 `Clock Out` 时向扩展发送一条命令
4. 扩展打开 IEYASU 页面
5. content script 识别按钮并回传结果

只要这 5 步跑通，就可以正式放弃“Playwright 复用真实 Chrome profile”这条高风险路线。
