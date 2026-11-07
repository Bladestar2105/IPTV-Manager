import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ getAll: vi.fn(), remove: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../src/database/db.js', () => ({ default: { prepare: () => ({ get: () => ({ id: 1 }), run: vi.fn() }) } }));
vi.mock('../../src/services/streamManager.js', () => ({ default: { getAll: state.getAll, remove: state.remove } }));
vi.mock('../../src/services/authService.js', () => ({ invalidateUserTokens: state.invalidate, invalidateUserCache: vi.fn() }));
vi.mock('../../src/services/cacheService.js', () => ({ clearChannelsCache: vi.fn() }));
vi.mock('../../src/utils/crypto.js', () => ({ encrypt: value => value, decrypt: value => value }));
const { updateUser } = await import('../../src/controllers/userController.js');

beforeEach(() => vi.clearAllMocks());

it('awaits the target user shared-ledger stream termination after a security change', async () => {
  state.getAll.mockResolvedValue([{ id: 'redis-stream', user_id: 1 }, { id: 'other-user', user_id: 2 }]);
  let finish;
  state.remove.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const pending = updateUser({ user: { is_admin: true }, params: { id: '1' }, body: { max_connections: 1 } }, res);
  await Promise.resolve();
  expect(state.remove).toHaveBeenCalledExactlyOnceWith('redis-stream');
  expect(state.invalidate).toHaveBeenCalledWith(1);
  expect(res.json).not.toHaveBeenCalled();
  finish(true);
  await pending;
  expect(state.invalidate).toHaveBeenCalledWith(1);
  expect(res.json).toHaveBeenCalledWith({ success: true });
});

it('preserves the administrator access check', async () => {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  await updateUser({ user: { is_admin: false }, params: { id: '1' }, body: { max_connections: 1 } }, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(state.getAll).not.toHaveBeenCalled();
});
