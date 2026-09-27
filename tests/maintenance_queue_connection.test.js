import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

it('reopens the latency connection after a transient initialization failure', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE admin_users(id INTEGER,is_active INTEGER,token_version INTEGER); INSERT INTO admin_users VALUES(1,1,0)');
  const open = vi.fn().mockImplementationOnce(() => { throw new Error('temporarily unavailable'); }).mockReturnValue(db);
  vi.doMock('../src/database/db.js', () => ({openLatencyDbConnection:open}));
  try {
    const {enqueueMaintenanceJobs} = await import('../src/services/maintenanceQueueService.js');
    const actor = {id:1,is_admin:true,token_version:0};
    await expect(enqueueMaintenanceJobs(actor,[])).rejects.toThrow('temporarily unavailable');
    await expect(enqueueMaintenanceJobs(actor,[])).resolves.toEqual([]);
    expect(open).toHaveBeenCalledTimes(2);
  } finally { vi.doUnmock('../src/database/db.js'); db.close(); }
});
