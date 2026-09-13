import { randomUUID } from 'node:crypto';
import db from '../../database/db.js';

function policy() {
  try { return JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'ai_policy'").get()?.value || '{}'); }
  catch { return {}; }
}

function title(text) {
  return String(text || '').replace(/https?:\/\/\S+/gi,'[URL]').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,240);
}

function rows(providerId) {
  return db.prepare(`SELECT uc.id AS user_channel_id,uc.provider_channel_id,cat.user_id,
    pc.name,pc.stream_type,cat.id AS category_id,cat.name AS category_name
    FROM authorized_user_channels uc JOIN user_categories cat ON cat.id = uc.user_category_id
    JOIN users u ON u.id = cat.user_id JOIN provider_channels pc ON pc.id = uc.provider_channel_id
    WHERE pc.provider_id = ? AND uc.is_hidden = 0 AND u.is_active = 1
    ORDER BY cat.user_id,uc.id LIMIT 50001`).all(providerId);
}

export function captureSyncSnapshot(providerId) {
  if (policy().enabled !== true) return null;
  try {
    const snapshot = rows(providerId);
    // ponytail: cap history work at 50k affected assignments; larger providers
    // need a paginated diff job, never a misleading partial removal report.
    return snapshot.length > 50000 ? null : snapshot;
  } catch { return null; }
}

const fields = row => row ? {name:title(row.name),category_id:row.category_id,category_name:title(row.category_name),stream_type:row.stream_type} : null;

export function recordSyncSnapshot(providerId, before) {
  if (!before || policy().enabled !== true) return [];
  try {
    const after = rows(providerId);
    if (after.length > 50000) return [];
    const previous = new Map(before.map(row => [row.user_channel_id,row]));
    const current = new Map(after.map(row => [row.user_channel_id,row]));
    const byUser = new Map();
    const reportFor = userId => {
      if (!byUser.has(userId)) byUser.set(userId,{provider_id:providerId,complete:true,source:'sync',timestamp:Date.now(),
        counts:{added:0,removed:0,renamed:0,reassigned:0},changes:[]});
      return byUser.get(userId);
    };
    const add = (kind,old,row) => {
      const ref = row || old;
      const report = reportFor(ref.user_id);
      report.counts[kind]++;
      report.changes.push({kind,provider_channel_id:ref.provider_channel_id,user_channel_id:ref.user_channel_id,before:fields(old),after:fields(row)});
    };
    for (const old of before) {
      reportFor(old.user_id);
      const row = current.get(old.user_channel_id);
      if (!row) add('removed',old,null);
      else {
        if (old.name !== row.name) add('renamed',old,row);
        if (old.category_id !== row.category_id || old.category_name !== row.category_name) add('reassigned',old,row);
      }
    }
    for (const row of after) {
      reportFor(row.user_id);
      if (!previous.has(row.user_channel_id)) add('added',null,row);
    }
    const saved = [];
    const insert = db.prepare('INSERT INTO ai_sync_snapshots (id,user_id,provider_id,data_json,created_at) VALUES (?,?,?,?,?)');
    db.transaction(() => {
      for (const [userId,report] of byUser) {
        const id = randomUUID();
        insert.run(id,userId,providerId,JSON.stringify(report),report.timestamp);
        saved.push({id,user_id:userId,added_ids:report.changes.filter(change => change.kind === 'added').map(change => change.provider_channel_id)});
      }
      db.prepare('DELETE FROM ai_sync_snapshots WHERE id IN (SELECT id FROM ai_sync_snapshots WHERE created_at < ? LIMIT ?)')
        .run(Date.now() - 30 * 86400000,Math.max(100,saved.length));
    })();
    return saved;
  } catch {
    // Reporting must never turn a successfully committed sync into a failure.
    return [];
  }
}

export function scheduleSyncFollowups(records) {
  if (!records.length) return;
  setImmediate(async () => {
    if (policy().enabled !== true) return;
    try {
      const {applyRulesAfterSync} = await import('./library.js');
      const {createJob} = await import('./jobs.js');
      for (const record of records) {
        try {
          for(let offset=0;offset<record.added_ids.length;offset+=5000) {
            applyRulesAfterSync(record.user_id,record.added_ids.slice(offset,offset+5000));
            await new Promise(resolve=>setImmediate(resolve));
          }
        } catch { /* Rule failures must not suppress the independent summary. */ }
        try {
          const preferences = JSON.parse(db.prepare('SELECT data_json FROM ai_preferences WHERE owner_key = ?').get(`user:${record.user_id}`)?.data_json || '{}');
          if (preferences.enabled && preferences.auto_sync_summary === true) {
            createJob({id:record.user_id,is_admin:false},{feature:'sync',snapshot_id:record.id},`sync_${record.id}`,{automatic:true});
          }
        } catch { /* Optional work cannot affect completed syncs. */ }
      }
    } catch { /* No work is retried against a model after an uncertain failure. */ }
  });
}
