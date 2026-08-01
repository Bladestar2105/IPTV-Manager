import { describe, expect, it } from 'vitest';
import * as streamFacade from '../../src/controllers/streamController.js';
import * as streamHelpers from '../../src/controllers/streamControllerHelpers.js';
import * as streamMedia from '../../src/controllers/streamMediaController.js';
import * as xtreamFacade from '../../src/controllers/xtreamController.js';
import * as xtreamUtils from '../../src/controllers/xtreamControllerUtils.js';
import * as migrationFacade from '../../src/database/migrations.js';
import * as migrationSchema from '../../src/database/migrationSchema.js';
import * as migrationSecurity from '../../src/database/migrationSecurity.js';
import * as migrationRuntime from '../../src/database/migrationRuntime.js';
import * as migrationAssignments from '../../src/database/migrationAssignments.js';
import * as migrationCatalog from '../../src/database/migrationCatalog.js';
import * as migrationStalker from '../../src/database/migrationStalker.js';

const exportNames = (...modules) => [...new Set(modules.flatMap(module => Object.keys(module)))].sort();
const directExports = (...names) => Object.fromEntries(names.map(name => [name, true]));

describe('module facade exports', () => {
  it('keeps the stream controller facade complete after extraction', () => {
    expect(Object.keys(streamFacade).sort()).toEqual(exportNames(
      streamHelpers,
      streamMedia,
      directExports('proxyLive', 'proxyMpd', 'proxySegment', 'proxyTimeshift')
    ));
  });

  it('keeps the Xtream controller facade complete after extraction', () => {
    expect(Object.keys(xtreamFacade).sort()).toEqual(exportNames(
      xtreamUtils,
      directExports('getPlaylist', 'playerApi', 'playerChannelsJson', 'playerPlaylist', 'xmltv')
    ));
  });

  it('re-exports every migration after the split', () => {
    expect(Object.keys(migrationFacade).sort()).toEqual(exportNames(
      migrationSchema,
      migrationSecurity,
      migrationRuntime,
      migrationAssignments,
      migrationCatalog,
      migrationStalker
    ));
  });
});
