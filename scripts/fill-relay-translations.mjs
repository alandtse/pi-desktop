// Fills the ru/uk relay + status-bar strings that the extractor created empty.
// i18next plural categories for ru/uk are one/few/many/other, so each counted key
// needs all four; the tests reject an empty value in any category.
import { readFileSync, writeFileSync } from 'node:fs'
// Imported rather than read from the global: scripts/**.mjs is linted without
// node globals, and a declared import keeps the file honest about where it comes from.
import process from 'node:process'

const RU = {
  'chat.composer.placeholderRemote':
    'Спросите сеанс на {{name}} — / для команд',
  'chat.emptyState.remoteEmpty':
    'В этом сеансе пока нет сообщений. Введите ниже, чтобы начать.',
  'chat.extensionUi.askCustomPlaceholder': 'Введите свой ответ',
  'chat.extensionUi.askRequired': 'Ответьте на обязательные вопросы, чтобы продолжить',
  'chat.extensionUi.askSubmit': 'Отправить ответы',
  'chat.loadingRemoteSession': 'Загрузка сеанса на другом устройстве…',
  'chat.remoteHistoryComplete_one': '{{count}} ход с другого устройства',
  'chat.remoteHistoryComplete_few': '{{count}} хода с другого устройства',
  'chat.remoteHistoryComplete_many': '{{count}} ходов с другого устройства',
  'chat.remoteHistoryComplete_other': '{{count}} хода с другого устройства',
  'chat.remoteHistoryPartial_one': '{{count}}+ ход с другого устройства',
  'chat.remoteHistoryPartial_few': '{{count}}+ хода с другого устройства',
  'chat.remoteHistoryPartial_many': '{{count}}+ ходов с другого устройства',
  'chat.remoteHistoryPartial_other': '{{count}}+ хода с другого устройства',
  'contextMenu.renameMachine': 'Переименовать устройство…',
  'contextMenu.unpairMachine': 'Отвязать это устройство',
  'contextMenu.useReportedName': 'Использовать сообщённое имя',
  'settings.relay.connection.connected': 'Подключено к ретранслятору',
  'settings.relay.connection.connecting': 'Подключение',
  'settings.relay.connection.error': 'Не удалось подключиться',
  'settings.relay.connection.idle': 'Не подключено',
  'settings.relay.connection.paired': 'Сопряжено и подключено',
  'settings.relay.intro':
    'Управляйте Pi, работающим на другом устройстве, через ваш собственный ретранслятор.',
  'settings.relay.pair.description':
    'Сопряжение выполняется один раз для каждого Pi. Ссылка одноразовая и истекает.',
  'settings.relay.pair.howTo':
    'На другом устройстве выполните /remote-pi pair и вставьте ссылку.',
  'settings.relay.pair.label': 'Сопряжённый Pi',
  'settings.relay.pair.nameDescription':
    'Показывается в боковой панели и на вкладках. Оставьте пустым, чтобы использовать сообщённое имя.',
  'settings.relay.pair.namePlaceholder': 'например, MacBook',
  'settings.relay.pair.pair': 'Сопрячь',
  'settings.relay.pair.rename': 'Переименовать',
  'settings.relay.pair.renamed': 'Имя устройства сохранено.',
  'settings.relay.pair.success': 'Сопряжено. Открытые сеансы Pi появятся ниже.',
  'settings.relay.pair.unpair': 'Отвязать',
  'settings.relay.sessions.empty': 'На сопряжённом Pi сейчас нет открытых сеансов.',
  'settings.relay.sessions.label': 'Сеансы на сопряжённом Pi',
  'settings.relay.sessions.refresh': 'Обновить',
  'settings.relay.sessions.selected': 'Управление этим сеансом',
  'settings.relay.url.description':
    'Ретранслятор, к которому подключаются оба устройства, например http://192.168.1.223:3000',
  'settings.relay.url.detected': 'Использовать ретранслятор, который уже использует это устройство: {{url}}',
  'settings.relay.url.label': 'URL ретранслятора',
  'settings.relay.url.save': 'Сохранить',
  'settings.resumeInterruptedTurn.description':
    'Если приложение закрылось посреди хода, отправить запрос в восстановленный сеанс, чтобы агент продолжил.',
  'settings.resumeInterruptedTurn.label': 'Продолжать прерванный ход',
  'settings.resumeInterruptedTurnPrompt.description':
    'Отправляется один раз после восстановления прерванного хода. «continue» работает как сокращение.',
  'settings.resumeInterruptedTurnPrompt.label': 'Запрос для продолжения',
  'settings.sections.remoteRelay': 'Удалённый ретранслятор Pi',
  'sidebar.remote.heading': 'Удалённо — {{name}}',
  'sidebar.remote.headingTitle': 'Сеансы на сопряжённом устройстве',
  'sidebar.sessionRow.remoteBadge': 'Сеанс на {{host}}',
  'statusBar.cacheShare': '{{percent}}% из кэша',
  'statusBar.messageCounts':
    '{{total}} сообщений: {{user}} от вас, {{assistant}} от агента, {{tools}} вызовов инструментов',
  'statusBar.tokenUsage':
    'Токены: {{total}} всего — {{input}} вход, {{output}} выход, {{cacheRead}} чтение кэша, {{cacheWrite}} запись кэша',
  'store.messages.actionError':
    'Не удалось выполнить {{action}} в удалённом сеансе: {{detail}}',
  'store.messages.continueInterruptedTurnError':
    'Не удалось продолжить прерванный ход: {{detail}}',
  'store.messages.continueInterruptedTurnNotReady':
    'Восстановленный сеанс не завершил загрузку, поэтому прерванный ход не был продолжен.',
  'store.messages.remoteHistoryTruncated_one':
    'Показан последний {{count}} ход. Другое устройство может хранить больше.',
  'store.messages.remoteHistoryTruncated_few':
    'Показаны последние {{count}} хода. Другое устройство может хранить больше.',
  'store.messages.remoteHistoryTruncated_many':
    'Показаны последние {{count}} ходов. Другое устройство может хранить больше.',
  'store.messages.remoteHistoryTruncated_other':
    'Показаны последние {{count}} хода. Другое устройство может хранить больше.',
  'store.messages.respondError': 'Не удалось ответить на удалённый запрос: {{detail}}',
  'store.messages.sendError': 'Не удалось отправить в удалённый сеанс: {{detail}}',
  'workspaceTabs.remoteSessionCount_one': '{{count}} сеанс',
  'workspaceTabs.remoteSessionCount_few': '{{count}} сеанса',
  'workspaceTabs.remoteSessionCount_many': '{{count}} сеансов',
  'workspaceTabs.remoteSessionCount_other': '{{count}} сеанса',
}

const UK = {
  'chat.composer.placeholderRemote':
    'Запитайте сеанс на {{name}} — / для команд',
  'chat.emptyState.remoteEmpty':
    'У цьому сеансі ще немає повідомлень. Введіть нижче, щоб почати.',
  'chat.extensionUi.askCustomPlaceholder': 'Введіть свою відповідь',
  'chat.extensionUi.askRequired': 'Дайте відповіді на обов’язкові питання, щоб продовжити',
  'chat.extensionUi.askSubmit': 'Надіслати відповіді',
  'chat.loadingRemoteSession': 'Завантаження сеансу на іншому пристрої…',
  'chat.remoteHistoryComplete_one': '{{count}} крок з іншого пристрою',
  'chat.remoteHistoryComplete_few': '{{count}} кроки з іншого пристрою',
  'chat.remoteHistoryComplete_many': '{{count}} кроків з іншого пристрою',
  'chat.remoteHistoryComplete_other': '{{count}} кроку з іншого пристрою',
  'chat.remoteHistoryPartial_one': '{{count}}+ крок з іншого пристрою',
  'chat.remoteHistoryPartial_few': '{{count}}+ кроки з іншого пристрою',
  'chat.remoteHistoryPartial_many': '{{count}}+ кроків з іншого пристрою',
  'chat.remoteHistoryPartial_other': '{{count}}+ кроку з іншого пристрою',
  'contextMenu.renameMachine': 'Перейменувати пристрій…',
  'contextMenu.unpairMachine': 'Від’єднати цей пристрій',
  'contextMenu.useReportedName': 'Використати повідомлену назву',
  'settings.relay.connection.connected': 'Підключено до ретранслятора',
  'settings.relay.connection.connecting': 'Підключення',
  'settings.relay.connection.error': 'Не вдалося підключитися',
  'settings.relay.connection.idle': 'Не підключено',
  'settings.relay.connection.paired': 'З’єднано та підключено',
  'settings.relay.intro':
    'Керуйте Pi, що працює на іншому пристрої, через ваш власний ретранслятор.',
  'settings.relay.pair.description':
    'З’єднання виконується один раз для кожного Pi. Посилання одноразове та має термін дії.',
  'settings.relay.pair.howTo':
    'На іншому пристрої виконайте /remote-pi pair і вставте посилання.',
  'settings.relay.pair.label': 'З’єднаний Pi',
  'settings.relay.pair.nameDescription':
    'Показується в бічній панелі та на вкладках. Залиште порожнім, щоб використати повідомлену назву.',
  'settings.relay.pair.namePlaceholder': 'наприклад, MacBook',
  'settings.relay.pair.pair': 'З’єднати',
  'settings.relay.pair.rename': 'Перейменувати',
  'settings.relay.pair.renamed': 'Назву пристрою збережено.',
  'settings.relay.pair.success': 'З’єднано. Відкриті сеанси Pi з’являться нижче.',
  'settings.relay.pair.unpair': 'Від’єднати',
  'settings.relay.sessions.empty': 'На з’єднаному Pi зараз немає відкритих сеансів.',
  'settings.relay.sessions.label': 'Сеанси на з’єднаному Pi',
  'settings.relay.sessions.refresh': 'Оновити',
  'settings.relay.sessions.selected': 'Керування цим сеансом',
  'settings.relay.url.description':
    'Ретранслятор, до якого підключаються обидва пристрої, наприклад http://192.168.1.223:3000',
  'settings.relay.url.detected': 'Використати ретранслятор, який уже використовує цей пристрій: {{url}}',
  'settings.relay.url.label': 'URL ретранслятора',
  'settings.relay.url.save': 'Зберегти',
  'settings.resumeInterruptedTurn.description':
    'Якщо застосунок закрився посеред кроку, надіслати запит у відновлений сеанс, щоб агент продовжив.',
  'settings.resumeInterruptedTurn.label': 'Продовжувати перерваний крок',
  'settings.resumeInterruptedTurnPrompt.description':
    'Надсилається один раз після відновлення перерваного кроку. «continue» працює як скорочення.',
  'settings.resumeInterruptedTurnPrompt.label': 'Запит для продовження',
  'settings.sections.remoteRelay': 'Віддалений ретранслятор Pi',
  'sidebar.remote.heading': 'Віддалено — {{name}}',
  'sidebar.remote.headingTitle': 'Сеанси на з’єднаному пристрої',
  'sidebar.sessionRow.remoteBadge': 'Сеанс на {{host}}',
  'statusBar.cacheShare': '{{percent}}% з кешу',
  'statusBar.messageCounts':
    '{{total}} повідомлень: {{user}} від вас, {{assistant}} від агента, {{tools}} викликів інструментів',
  'statusBar.tokenUsage':
    'Токени: {{total}} усього — {{input}} вхід, {{output}} вихід, {{cacheRead}} читання кешу, {{cacheWrite}} запис кешу',
  'store.messages.actionError':
    'Не вдалося виконати {{action}} у віддаленому сеансі: {{detail}}',
  'store.messages.continueInterruptedTurnError':
    'Не вдалося продовжити перерваний крок: {{detail}}',
  'store.messages.continueInterruptedTurnNotReady':
    'Відновлений сеанс не завершив завантаження, тому перерваний крок не було продовжено.',
  'store.messages.remoteHistoryTruncated_one':
    'Показано останній {{count}} крок. Інший пристрій може зберігати більше.',
  'store.messages.remoteHistoryTruncated_few':
    'Показано останні {{count}} кроки. Інший пристрій може зберігати більше.',
  'store.messages.remoteHistoryTruncated_many':
    'Показано останні {{count}} кроків. Інший пристрій може зберігати більше.',
  'store.messages.remoteHistoryTruncated_other':
    'Показано останні {{count}} кроку. Інший пристрій може зберігати більше.',
  'store.messages.respondError': 'Не вдалося відповісти на віддалений запит: {{detail}}',
  'store.messages.sendError': 'Не вдалося надіслати у віддалений сеанс: {{detail}}',
  'workspaceTabs.remoteSessionCount_one': '{{count}} сеанс',
  'workspaceTabs.remoteSessionCount_few': '{{count}} сеанси',
  'workspaceTabs.remoteSessionCount_many': '{{count}} сеансів',
  'workspaceTabs.remoteSessionCount_other': '{{count}} сеансу',
}

/** Sets a dotted path, creating intermediate objects. */
function setPath(root, dotted, value) {
  const parts = dotted.split('.')
  let node = root
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {}
    node = node[part]
  }
  node[parts.at(-1)] = value
}

function flat(root, prefix = '') {
  const out = {}
  for (const [key, value] of Object.entries(root)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) Object.assign(out, flat(value, path))
    else out[path] = value
  }
  return out
}

for (const [locale, table] of [['ru', RU], ['uk', UK]]) {
  const file = `resources/locales/${locale}/translation.json`
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const before = flat(data)
  let filled = 0
  for (const [key, value] of Object.entries(table)) {
    // Only fill what the extractor left blank: a real translation that already
    // exists must never be overwritten by this script.
    if (before[key] === '') {
      setPath(data, key, value)
      filled += 1
    }
  }
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  const after = flat(data)
  const still = Object.entries(after).filter(([, value]) => value === '')
  process.stdout.write(`${locale}: filled ${filled}, still empty ${still.length}
`)
  for (const [key] of still) process.stdout.write(`   EMPTY ${key}
`)
}
