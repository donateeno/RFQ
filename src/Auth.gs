/**
 * Who is using the app. Deploy as "Execute as: Me" + "Who has access: anyone in eve.co.th",
 * so Session.getActiveUser() returns the viewer's company email.
 */

var userMemo_ = null;

function currentUser_() {
  if (userMemo_) return userMemo_;
  var email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) throw new Error('ไม่พบอีเมลผู้ใช้ — กรุณาเข้าสู่ระบบด้วยบัญชีบริษัท');
  var domain = String(getSettings_().ALLOWED_DOMAIN || '').trim().toLowerCase();
  if (domain && email.split('@')[1] !== domain) {
    throw new Error('อนุญาตเฉพาะบัญชี @' + domain);
  }
  var user = { email: email, name: email.split('@')[0], role: ROLE.SALES };
  readTable_(SHEET.USERS).rows.forEach(function (r) {
    if (String(r.Email).trim().toLowerCase() !== email) return;
    if (r.Active !== '' && !toBool_(r.Active)) throw new Error('บัญชีนี้ถูกปิดการใช้งาน');
    user.name = String(r.Name || user.name);
    var role = String(r.Role || '').trim().toUpperCase();
    if (ROLE[role]) user.role = role;
  });
  user.canApprove = user.role === ROLE.SUPERVISOR || user.role === ROLE.ADMIN;
  user.isAdmin = user.role === ROLE.ADMIN;
  userMemo_ = user;
  return user;
}

function requireRole_(user, roles) {
  if (roles.indexOf(user.role) === -1) throw new Error('คุณไม่มีสิทธิ์ใช้งานส่วนนี้');
  return user;
}

/** Emails of active supervisors/admins + NOTIFY_EMAILS. */
function approverEmails_() {
  var list = readTable_(SHEET.USERS).rows.filter(function (r) {
    var role = String(r.Role).trim().toUpperCase();
    return (role === ROLE.SUPERVISOR || role === ROLE.ADMIN) && (r.Active === '' || toBool_(r.Active));
  }).map(function (r) { return String(r.Email).trim().toLowerCase(); });
  String(getSettings_().NOTIFY_EMAILS || '').split(',').forEach(function (e) {
    e = e.trim().toLowerCase();
    if (e && list.indexOf(e) === -1) list.push(e);
  });
  return list;
}
