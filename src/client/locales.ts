export type KomariKey =
  | 'page.summary'
  | 'page.unavailable'
  | 'page.readOnly'
  | 'field.endpoint'
  | 'field.endpoint.placeholder'
  | 'field.username'
  | 'field.password'
  | 'field.requestTimeoutMs'
  | 'field.transferTimeoutMs'
  | 'hint.credentials'
  | 'hint.exec'
  | 'action.save'
  | 'action.saved'
  | 'action.saveFailed'
  | 'action.test'
  | 'action.testing'
  | 'test.ok'
  | 'test.failed'
  | 'test.error'

export const NS = 'dsh-komari'

export const en: Record<KomariKey, string> = {
  'page.summary': 'Configure the Komari panel address and account; komari_list_nodes / komari_exec read these values live — no restart needed.',
  'page.unavailable': 'Configuration is unavailable (this host does not serve the plugin entry).',
  'page.readOnly': 'The active profile does not accept configuration edits.',
  'field.endpoint': 'Panel address',
  'field.endpoint.placeholder': 'https://status.example.com',
  'field.username': 'Username',
  'field.password': 'Password',
  'field.requestTimeoutMs': 'Request timeout (ms)',
  'field.transferTimeoutMs': 'Transfer timeout (ms)',
  'hint.credentials': 'The account must be a panel administrator. Credentials are stored in the profile cordis.patch.yml in plain text; an account with 2FA enabled cannot be used here.',
  'hint.exec': 'komari_exec runs real commands on the monitored machines with the agent privileges (root on most Linux nodes).',
  'action.save': 'Save',
  'action.saved': 'Saved',
  'action.saveFailed': 'Save failed',
  'action.test': 'Test connection',
  'action.testing': 'Testing…',
  'test.ok': 'Connected',
  'test.failed': 'No machines reported',
  'test.error': 'Connection failed',
}

export const zh: Record<KomariKey, string> = {
  'page.summary': '配置 Komari 面板地址与账号；komari_list_nodes / komari_exec 每次调用都读取最新值，无需重启。',
  'page.unavailable': '配置暂不可用（当前 host 未提供此插件条目）。',
  'page.readOnly': '当前 profile 不接受配置修改。',
  'field.endpoint': '面板地址',
  'field.endpoint.placeholder': 'https://status.example.com',
  'field.username': '用户名',
  'field.password': '密码',
  'field.requestTimeoutMs': '请求超时 (ms)',
  'field.transferTimeoutMs': '传输超时 (ms)',
  'hint.credentials': '账号需具备面板管理员权限。凭据以明文保存在 profile 的 cordis.patch.yml 中；开启 2FA 的账号无法在此使用。',
  'hint.exec': 'komari_exec 会以目标机 agent 的权限执行真实命令（多数 Linux 节点即 root）。',
  'action.save': '保存',
  'action.saved': '已保存',
  'action.saveFailed': '保存失败',
  'action.test': '测试连接',
  'action.testing': '测试中…',
  'test.ok': '连接成功',
  'test.failed': '未取到机器',
  'test.error': '连接失败',
}
