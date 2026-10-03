// Статистика игроков: доигранные и брошенные пули, сумма вистов. Хранится в JSON рядом со столами.
import fs from 'node:fs';
import path from 'node:path';

export class Stats {
  constructor(file) {
    this.file = file;
    this.players = new Map(); // userId → { id, name, photo, finished, unfinished, whists, lastPlayed }
    this.saveTimer = null;
    try {
      for (const p of JSON.parse(fs.readFileSync(file, 'utf8'))) this.players.set(p.id, p);
    } catch { /* файла ещё нет */ }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.players.values()]));
      fs.renameSync(tmp, this.file);
    }, 500);
  }

  entry(user) {
    let p = this.players.get(user.id);
    if (!p) {
      p = { id: user.id, name: user.name, photo: user.photo || null, finished: 0, unfinished: 0, whists: 0, lastPlayed: null };
      this.players.set(user.id, p);
    }
    return p;
  }

  // Обновить имя/фото, если игрок уже есть в статистике (имя в Telegram могло смениться)
  touch(user) {
    const p = this.players.get(user.id);
    if (p && (p.name !== user.name || (user.photo && p.photo !== user.photo))) {
      p.name = user.name;
      if (user.photo) p.photo = user.photo;
      this.save();
    }
  }

  // Итог пули для одного игрока: finished — доиграл сам; whists — его итог в вистах (может быть null)
  record(user, { finished, whists }) {
    const p = this.entry(user);
    p.name = user.name;
    if (finished) p.finished += 1; else p.unfinished += 1;
    if (whists != null) p.whists = Math.round((p.whists + whists) * 100) / 100;
    p.lastPlayed = Date.now();
    this.save();
  }

  view(id) {
    const p = this.players.get(id);
    if (!p) return null;
    const total = p.finished + p.unfinished;
    return { ...p, games: total, finishRate: total ? Math.round((p.finished / total) * 100) : null };
  }

  // Рейтинг по сумме вистов среди тех, кто сыграл хотя бы одну пулю
  top(n = 20) {
    return [...this.players.values()]
      .filter((p) => p.finished + p.unfinished > 0)
      .sort((a, b) => b.whists - a.whists)
      .slice(0, n)
      .map((p) => this.view(p.id));
  }
}
