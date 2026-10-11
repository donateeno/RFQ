// Google Identity Services callback (named in data-callback on login.html).
window.rfqSignIn = function (response) {
  var msg = document.getElementById('msg');
  msg.textContent = '';
  fetch('/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential: response.credential })
  }).then(function (r) { return r.json(); }).then(function (r) {
    if (r.ok) location.href = '/' + location.hash;
    else msg.textContent = r.error || 'เข้าสู่ระบบไม่สำเร็จ';
  }).catch(function () { msg.textContent = 'เชื่อมต่อไม่ได้ กรุณาลองใหม่'; });
};
