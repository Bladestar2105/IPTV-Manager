export function migrateProviderUseMappedEpgIcon(db) {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(providers)").all();
    const columns = tableInfo.map(c => c.name);

    if (!columns.includes('use_mapped_epg_icon')) {
      db.exec('ALTER TABLE providers ADD COLUMN use_mapped_epg_icon INTEGER DEFAULT 0');
      console.log('✅ DB Migration: use_mapped_epg_icon column added to providers');
    }
  } catch (e) {
    console.error('Provider use_mapped_epg_icon migration error:', e);
  }
}

export function migrateProviderIconCache(db) {
  try {
    // Create table to track cached icons per provider
    // This allows sharing cached icons among users with the same provider
    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_icon_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id INTEGER NOT NULL,
        logo_url TEXT NOT NULL,
        cache_hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        last_accessed INTEGER DEFAULT (strftime('%s', 'now')),
        access_count INTEGER DEFAULT 0,
        UNIQUE(provider_id, logo_url),
        FOREIGN KEY (provider_id) REFERENCES providers(id)
      )
    `);

    // Create index for fast lookups
    db.exec('CREATE INDEX IF NOT EXISTS idx_provider_icon_cache_provider ON provider_icon_cache(provider_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_provider_icon_cache_hash ON provider_icon_cache(cache_hash)');

    console.log('✅ DB Migration: provider_icon_cache table created');
  } catch (e) {
    console.error('Provider Icon Cache migration error:', e);
  }
}

export function migrateEpgMappingJobs(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS epg_mapping_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        matched INTEGER DEFAULT 0,
        message TEXT,
        error TEXT,
        status_code INTEGER,
        user_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_epg_mapping_jobs_updated ON epg_mapping_jobs(updated_at)');
  } catch (e) {
    console.error('EPG mapping jobs migration error:', e);
  }
}

export function migrateSeriesEpisodes(db) {
  const migrate = db.transaction(() => {
    const expectedEpisodeKey = 'source_key,series_remote_id,remote_episode_id';
    const episodeColumns = db.prepare('PRAGMA table_info(provider_series_episodes)').all().map(column => column.name);
    const stateColumns = db.prepare('PRAGMA table_info(provider_series_state)').all().map(column => column.name);
    let rebuildCache = (episodeColumns.length > 0 && !episodeColumns.includes('source_key')) ||
      (stateColumns.length > 0 && !stateColumns.includes('source_key'));

    if (episodeColumns.length > 0 && !rebuildCache) {
      const uniqueKeys = db.prepare(`
        SELECT name
        FROM pragma_index_list('provider_series_episodes')
        WHERE "unique" = 1
      `).all().map(index => db.prepare(
        'SELECT name FROM pragma_index_info(?) ORDER BY seqno'
      ).all(index.name).map(column => column.name).join(','));
      rebuildCache = uniqueKeys.length !== 1 || uniqueKeys[0] !== expectedEpisodeKey;
    }

    if (rebuildCache) {
      db.exec(`
        DROP TABLE IF EXISTS provider_series_episodes;
        DROP TABLE IF EXISTS provider_series_state;
      `);
      console.info('✅ DB Migration: series episode cache rebuilt with series-scoped keys');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS provider_series_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_key TEXT NOT NULL,
        series_remote_id INTEGER NOT NULL,
        remote_episode_id INTEGER NOT NULL,
        season INTEGER DEFAULT 0,
        episode_num INTEGER DEFAULT 0,
        title TEXT DEFAULT '',
        container_extension TEXT DEFAULT 'mp4',
        logo TEXT DEFAULT '',
        added TEXT DEFAULT '',
        UNIQUE(source_key, series_remote_id, remote_episode_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pse_series
        ON provider_series_episodes(source_key, series_remote_id, season, episode_num);

      CREATE TABLE IF NOT EXISTS provider_series_state (
        source_key TEXT NOT NULL,
        series_remote_id INTEGER NOT NULL,
        last_modified TEXT DEFAULT '',
        synced_at INTEGER DEFAULT 0,
        PRIMARY KEY (source_key, series_remote_id)
      );

      CREATE TABLE IF NOT EXISTS series_episode_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id >= 900000000 AND id < 1000000000),
        user_channel_id INTEGER NOT NULL,
        source_key TEXT NOT NULL,
        series_remote_id INTEGER NOT NULL,
        remote_episode_id INTEGER NOT NULL,
        UNIQUE(user_channel_id, source_key, series_remote_id, remote_episode_id),
        FOREIGN KEY (user_channel_id) REFERENCES user_channels(id) ON DELETE CASCADE
      );
    `);

    const aliasForeignKeys = db.prepare("PRAGMA foreign_key_list('series_episode_aliases')").all();
    const hasAliasCascade = aliasForeignKeys.some(key =>
      key.table === 'user_channels' &&
      key.from === 'user_channel_id' &&
      key.to === 'id' &&
      String(key.on_delete).toUpperCase() === 'CASCADE'
    );

    if (!hasAliasCascade) {
      db.exec(`
        DROP TABLE IF EXISTS series_episode_aliases_new;
        CREATE TABLE series_episode_aliases_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id >= 900000000 AND id < 1000000000),
          user_channel_id INTEGER NOT NULL,
          source_key TEXT NOT NULL,
          series_remote_id INTEGER NOT NULL,
          remote_episode_id INTEGER NOT NULL,
          UNIQUE(user_channel_id, source_key, series_remote_id, remote_episode_id),
          FOREIGN KEY (user_channel_id) REFERENCES user_channels(id) ON DELETE CASCADE
        );
        INSERT INTO series_episode_aliases_new
          (id, user_channel_id, source_key, series_remote_id, remote_episode_id)
        SELECT a.id, a.user_channel_id, a.source_key, a.series_remote_id, a.remote_episode_id
        FROM series_episode_aliases a
        JOIN user_channels uc ON uc.id = a.user_channel_id;
        DROP TABLE series_episode_aliases;
        ALTER TABLE series_episode_aliases_new RENAME TO series_episode_aliases;
      `);
      console.info('✅ DB Migration: series episode aliases rebuilt with cascading assignment cleanup');
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_series_episode_aliases_user_channel
        ON series_episode_aliases(user_channel_id);
    `);

    const aliasSequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'series_episode_aliases'").get();
    if (!aliasSequence) {
      db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES ('series_episode_aliases', 900000000)").run();
    } else if (Number(aliasSequence.seq) < 900000000) {
      db.prepare("UPDATE sqlite_sequence SET seq = 900000000 WHERE name = 'series_episode_aliases'").run();
    }

    const columns = db.prepare('PRAGMA table_info(sync_configs)').all().map(column => column.name);
    if (!columns.includes('sync_series_episodes')) {
      db.exec('ALTER TABLE sync_configs ADD COLUMN sync_series_episodes INTEGER DEFAULT 1');
      console.info('✅ DB Migration: sync_series_episodes column added to sync_configs');
    }
  });

  try {
    migrate();
  } catch (e) {
    console.error('Series episodes migration error:', e);
    throw e;
  }
}
