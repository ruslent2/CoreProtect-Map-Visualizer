import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** Зберігає OAuth-стани, сесії та чорний список окремо від CoreProtect. */
export class AuthStore {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        discord_id TEXT NOT NULL,
        username TEXT NOT NULL,
        avatar TEXT,
        role TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        token_expires_at INTEGER NOT NULL,
        roles_checked_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_discord_id ON sessions(discord_id);
      CREATE TABLE IF NOT EXISTS blacklist (
        discord_id TEXT PRIMARY KEY,
        added_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /** Записує одноразовий OAuth state. */
  createState(stateHash, verifier, expiresAt) {
    this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(Date.now());
    this.db.prepare('INSERT INTO oauth_states (state_hash, verifier, expires_at) VALUES (?, ?, ?)').run(stateHash, verifier, expiresAt);
  }

  /** Атомарно споживає OAuth state. */
  consumeState(stateHash) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM oauth_states WHERE state_hash = ? AND expires_at > ?').get(stateHash, Date.now());
      if (row) this.db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash);
      return row;
    });
    return transaction();
  }

  createSession(session) {
    this.db.prepare(`INSERT INTO sessions
      (token_hash, discord_id, username, avatar, role, access_token, refresh_token, token_expires_at, roles_checked_at, expires_at)
      VALUES (@tokenHash, @discordId, @username, @avatar, @role, @accessToken, @refreshToken, @tokenExpiresAt, @rolesCheckedAt, @expiresAt)`)
      .run(session);
  }

  getSession(tokenHash) {
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Date.now());
  }

  updateSession(tokenHash, values) {
    this.db.prepare(`UPDATE sessions SET role = @role, access_token = @accessToken, refresh_token = @refreshToken,
      token_expires_at = @tokenExpiresAt, roles_checked_at = @rolesCheckedAt WHERE token_hash = @tokenHash`)
      .run({ tokenHash, ...values });
  }

  deleteSession(tokenHash) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); }
  revokeUser(discordId) { this.db.prepare('DELETE FROM sessions WHERE discord_id = ?').run(discordId); }
  isBlocked(discordId) { return !!this.db.prepare('SELECT 1 FROM blacklist WHERE discord_id = ?').get(discordId); }
  listBlacklist() { return this.db.prepare('SELECT discord_id AS discordId, added_by AS addedBy, created_at AS createdAt FROM blacklist ORDER BY created_at DESC').all(); }

  block(discordId, addedBy) {
    this.db.prepare('INSERT OR REPLACE INTO blacklist (discord_id, added_by, created_at) VALUES (?, ?, ?)').run(discordId, addedBy, Date.now());
    this.revokeUser(discordId);
  }

  unblock(discordId) { return this.db.prepare('DELETE FROM blacklist WHERE discord_id = ?').run(discordId).changes > 0; }
  close() { this.db.close(); }
}
