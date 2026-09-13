import db from '../../../database/db.js';

// One definition of "this identity may use the subsystem", shared by the lease,
// the account service and the credential store. Keeping it in one place is the
// point: three copies of the same access rule drift, and each copy is a place
// where one of them can be forgotten.
//
// Returns the account row, so a caller that needs the token version does not
// have to load it again.
export function accountRow(ownerKey) {
    const [kind, id] = String(ownerKey || '').split(':');
    const admin = kind === 'admin';
    if (!admin && kind !== 'user') return null;
    const table = admin ? 'admin_users' : 'users';
    const row = db.prepare(`SELECT id,is_active,token_version${admin ? '' : ',webui_access,expiry_date'} FROM ${table} WHERE id=?`).get(Number(id));
    if (!row || !row.is_active) return null;
    if (!admin && (!row.webui_access || (row.expiry_date && row.expiry_date < Date.now() / 1000))) return null;
    return row;
}
