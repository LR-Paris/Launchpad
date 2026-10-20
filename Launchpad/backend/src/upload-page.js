// ---------------------------------------------------------------------------
// upload-page.js — the page behind an upload link.
//
// request_upload hands out https://lrparisstore.com/api/upload/<ticket> as "a
// browser link for a person to drop a DATABASE into", but only the POST existed,
// so opening the link gave a 404 and the person was stuck. This is the page:
// it says which shop the link is for and until when, takes one zip by drop or
// picker, and posts it back to the same address as multipart. Opening the page
// does not use the ticket up. Only the upload does.
//
// Self-contained on purpose: no external fonts, scripts or images, so the
// ticket in the address never leaks to another host in a Referer.
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

const STYLE = `
  :root { --ink:#111; --muted:#5f6368; --line:#e3e3e3; --bg:#f6f5f2; --card:#fff; --ok:#1e6b43; --bad:#b42318; --accent:#111; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width:560px; margin:0 auto; padding:48px 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
  .brand { font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:0 0 20px; }
  h1 { font-size:22px; line-height:1.3; margin:0 0 6px; }
  p { margin:0 0 12px; }
  .muted { color:var(--muted); font-size:14px; }
  .drop { margin:20px 0 8px; border:2px dashed #c9c9c9; border-radius:10px; padding:32px 16px; text-align:center; transition:border-color .15s, background .15s; }
  .drop.over { border-color:var(--accent); background:#fafafa; }
  .drop strong { display:block; font-size:17px; margin-bottom:8px; }
  button { font:inherit; font-weight:600; background:var(--accent); color:#fff; border:0; border-radius:8px; padding:10px 18px; cursor:pointer; }
  button:focus-visible { outline:3px solid #8ab4f8; outline-offset:2px; }
  .bar { height:8px; background:#ececec; border-radius:4px; overflow:hidden; margin:12px 0 6px; }
  .bar > span { display:block; height:100%; width:0; background:var(--accent); transition:width .2s; }
  .ok { color:var(--ok); }
  .bad { color:var(--bad); }
  ul { margin:8px 0 12px; padding-left:20px; }
  li { margin:4px 0; font-size:14px; }
  .hidden { display:none; }
  .counts { display:flex; gap:16px; flex-wrap:wrap; margin:12px 0; font-size:14px; }
  .counts b { font-size:20px; display:block; }
`;

function shell(title, body, script = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="card">
<p class="brand">LR Paris · Shuttle</p>
${body}
</div>
</main>
${script}
</body>
</html>`;
}

function deadPage({ state, slug, stagingId }) {
  const shop = slug ? ` for ${esc(slug)}` : '';
  if (state === 'used') {
    return shell('Upload link already used', `
<h1>This upload link was already used</h1>
${stagingId
    ? `<p>The zip${shop} arrived and is waiting for review. Nothing on the shop changed yet.</p>
<p class="muted">Go back to your assistant. It reads you the changes and applies them when you say yes.</p>`
    : `<p>Each link takes one zip. Ask your assistant for a new link.</p>`}`);
  }
  if (state === 'expired') {
    return shell('Upload link expired', `
<h1>This upload link expired</h1>
<p>Upload links work for fifteen minutes${shop}. Ask your assistant for a new one.</p>`);
  }
  return shell('Upload link not found', `
<h1>This upload link does not work</h1>
<p>Check that the whole address was copied. Otherwise, ask your assistant for a new link.</p>`);
}

function readyPage({ slug, expiresAt, maxBytes }) {
  const maxMb = Math.round(maxBytes / 1024 / 1024);
  const body = `
<h1>Upload the DATABASE for ${esc(slug)}</h1>
<p class="muted">This link takes one zip and works until <span id="expiry">${esc(new Date(expiresAt).toISOString())}</span>.</p>

<div id="pick">
  <div class="drop" id="drop">
    <strong>Drop the DATABASE zip here</strong>
    <p class="muted">or</p>
    <button type="button" id="choose">Choose a zip</button>
    <input type="file" id="file" accept=".zip,application/zip" class="hidden">
  </div>
  <p class="muted">Zip the whole DATABASE folder, up to ${maxMb} MB. Nothing on the shop changes until someone reviews the changes and applies them.</p>
</div>

<div id="progress" class="hidden" aria-live="polite">
  <p id="status">Uploading…</p>
  <div class="bar"><span id="fill"></span></div>
  <p class="muted" id="detail"></p>
</div>

<div id="done" class="hidden" aria-live="polite"></div>`;

  const script = `<script>
(function () {
  var maxBytes = ${Number(maxBytes)};
  var expiry = document.getElementById('expiry');
  try {
    var d = new Date(expiry.textContent);
    expiry.textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch (e) {}

  var drop = document.getElementById('drop');
  var input = document.getElementById('file');
  document.getElementById('choose').addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () { if (input.files && input.files[0]) send(input.files[0]); });
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) send(f);
  });

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function show(id) {
    ['pick', 'progress', 'done'].forEach(function (x) {
      document.getElementById(x).classList.toggle('hidden', x !== id);
    });
  }
  function fail(message, resolution, retry) {
    var done = document.getElementById('done');
    done.innerHTML = '';
    done.appendChild(el('h1', 'bad', 'The upload did not go through'));
    done.appendChild(el('p', '', message || 'Something went wrong on the way.'));
    if (resolution) done.appendChild(el('p', 'muted', resolution));
    if (retry) {
      var b = el('button', '', 'Try another file');
      b.type = 'button';
      b.addEventListener('click', function () { input.value = ''; show('pick'); });
      done.appendChild(b);
    }
    show('done');
  }

  function send(file) {
    if (!/\\.zip$/i.test(file.name)) {
      return fail('That file is not a zip.', 'Right-click the DATABASE folder, choose Compress, then drop the zip here.', true);
    }
    if (file.size > maxBytes) {
      return fail('That zip is larger than the ' + Math.round(maxBytes / 1048576) + ' MB limit.', 'Photos are usually the reason. Resize them, zip the folder again, and drop it here.', true);
    }
    show('progress');
    var status = document.getElementById('status');
    var fill = document.getElementById('fill');
    var detail = document.getElementById('detail');
    status.textContent = 'Uploading ' + file.name + '…';

    var form = new FormData();
    form.append('file', file, file.name);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', window.location.pathname);
    xhr.upload.addEventListener('progress', function (e) {
      if (!e.lengthComputable) return;
      var pct = Math.round((e.loaded / e.total) * 100);
      fill.style.width = pct + '%';
      detail.textContent = pct + '%';
      if (pct >= 100) { status.textContent = 'Checking the folder…'; detail.textContent = ''; }
    });
    xhr.addEventListener('load', function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && data && data.staging_id) return staged(data);
      var err = data && data.error;
      fail(err && err.message ? err.message : 'The server answered ' + xhr.status + '.',
        err && err.resolution ? err.resolution : 'Ask your assistant for a new link and try again.', false);
    });
    xhr.addEventListener('error', function () {
      fail('The connection dropped before the upload finished.', 'Ask your assistant for a new link and try again.', false);
    });
    xhr.send(form);
  }

  function staged(data) {
    var diff = data.diff || {};
    var p = diff.products || {};
    var done = document.getElementById('done');
    done.innerHTML = '';
    var blocking = diff.blocking || [];
    done.appendChild(el('h1', blocking.length ? 'bad' : 'ok', blocking.length ? 'Uploaded, but it cannot be applied yet' : 'Uploaded'));
    done.appendChild(el('p', '', 'Nothing on the shop changed yet.'));
    var counts = el('div', 'counts');
    [['added', p.added], ['removed', p.removed], ['renamed', p.renamed]].forEach(function (c) {
      var box = el('div');
      box.appendChild(el('b', '', String((c[1] || []).length)));
      box.appendChild(document.createTextNode('products ' + c[0]));
      counts.appendChild(box);
    });
    done.appendChild(counts);
    if (blocking.length) {
      done.appendChild(el('p', 'bad', 'What has to be fixed first:'));
      var ub = el('ul');
      blocking.slice(0, 8).forEach(function (w) { ub.appendChild(el('li', '', w)); });
      done.appendChild(ub);
    }
    var warnings = diff.warnings || [];
    if (warnings.length) {
      done.appendChild(el('p', 'muted', 'Worth a look:'));
      var uw = el('ul');
      warnings.slice(0, 8).forEach(function (w) { uw.appendChild(el('li', '', w)); });
      done.appendChild(uw);
    }
    done.appendChild(el('p', 'muted', 'Go back to your assistant and say it is uploaded. It reads you the changes and applies them when you say yes.'));
    show('done');
  }
})();
</script>`;

  return shell(`Upload the DATABASE for ${slug}`, body, script);
}

function uploadPage(opts) {
  return opts.state === 'ready' ? readyPage(opts) : deadPage(opts);
}

module.exports = { uploadPage };
