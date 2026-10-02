// Telegram: проверка initData Mini App и минимальный бот на long polling (без сторонних библиотек).
import crypto from 'node:crypto';

export function validateInitData(initData, botToken, maxAgeSec = 7 * 24 * 3600) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  const user = JSON.parse(params.get('user') || 'null');
  if (!user) return null;
  return {
    user: {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Игрок',
      photo: user.photo_url || null,
    },
    startParam: params.get('start_param') || null,
  };
}

export class Bot {
  constructor(token, { onUpdate, webAppUrl } = {}) {
    this.token = token;
    this.onUpdate = onUpdate;
    this.webAppUrl = webAppUrl;
    this.offset = 0;
    this.me = null;
  }

  async call(method, body = {}) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
    return json.result;
  }

  send(chatId, text, extra = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...extra }).catch((e) => {
      console.error('[bot] send failed:', e.message);
      return null;
    });
  }

  async start() {
    this.me = await this.call('getMe');
    await this.call('setMyCommands', {
      commands: [
        { command: 'newgame', description: 'Новая пуля в этом чате' },
        { command: 'score', description: 'Текущий счёт' },
        { command: 'help', description: 'Как играть' },
      ],
    }).catch(() => {});
    await this.setup().catch((e) => console.error('[bot] настройка профиля:', e.message));
    console.log(`[bot] @${this.me.username} запущен`);
    this.loop();
  }

  // Профиль бота настраивается сам при каждом запуске — в BotFather руками ничего не нужно
  async setup() {
    if (this.webAppUrl) {
      await this.call('setChatMenuButton', {
        menu_button: { type: 'web_app', text: '🃏 Играть', web_app: { url: this.webAppUrl } },
      });
    }
    await this.call('setMyShortDescription', {
      short_description: 'Преферанс «Сочинка» на троих: с друзьями в группе или против ИИ',
    });
    await this.call('setMyDescription', {
      description: [
        'Преферанс «Сочинка» прямо в Telegram.',
        '',
        '🤖 Один — жмите «Играть» и садитесь против ИИ (от новичка до мастера).',
        '👥 С друзьями — создайте группу на троих, добавьте меня и напишите /newgame. Видеочат группы работает во время игры.',
      ].join('\n'),
    });
  }

  async loop() {
    for (;;) {
      try {
        const updates = await this.call('getUpdates', {
          offset: this.offset,
          timeout: 50,
          allowed_updates: ['message'],
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try { await this.onUpdate?.(u); } catch (e) { console.error('[bot] update error:', e); }
        }
      } catch (e) {
        console.error('[bot] polling error:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}
