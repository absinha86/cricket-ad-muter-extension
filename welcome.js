const $ = (id) => document.getElementById(id);

// One checkbox per site; Chrome's prompt then names only the ticked ones.
// Sites already allowed (say, JioHotstar for users updating from 1.0) show
// as allowed and aren't asked for again.
const picks = new Map(); // site id -> checkbox
for (const site of SITES) {
  const label = document.createElement('label');
  label.className = 'pick';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = true;
  box.addEventListener('change', renderButton);
  const text = document.createElement('span');
  const name = document.createElement('b'); name.textContent = site.name;
  const domains = document.createElement('small');
  domains.textContent = site.pages.map((p) => p.replace(/^\*:\/\/\*\.|\/\*$/g, '')).join(', ');
  const state = document.createElement('em'); state.textContent = '✓ Allowed';
  text.append(name, domains);
  label.append(box, text, state);
  $('picks').append(label);
  picks.set(site.id, box);
}

const wanted = () => SITES.filter((s) => picks.get(s.id).checked && !picks.get(s.id).disabled);

function renderButton() {
  const sites = wanted();
  $('grant').disabled = !sites.length;
  $('grant').textContent = sites.length ? `Allow access to ${siteList(sites, 'and')}` : 'Pick a site';
}

async function render() {
  const granted = await grantedSites();
  for (const s of SITES) {
    const box = picks.get(s.id);
    const ok = granted.includes(s);
    box.disabled = ok;
    if (ok) box.checked = true;
    box.closest('.pick').classList.toggle('allowed', ok);
  }
  const all = granted.length === SITES.length;
  $('grant').hidden = all;
  $('granted').hidden = !granted.length;
  $('granted').textContent = granted.length ? `✓ ${siteList(granted, 'and')} allowed` : '';
  $('stepAccess').classList.toggle('complete', granted.length > 0);
  renderButton();
  return granted;
}

$('grant').addEventListener('click', async () => {
  await chrome.permissions.request({ origins: wanted().flatMap(siteOrigins) }).catch(() => false);
  render();
});

for (const site of SITES) {
  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.textContent = `Open ${site.name}`;
  btn.addEventListener('click', () => { location.href = site.home; });
  $('open').appendChild(btn);
}

render().then((granted) => {
  // Reopened by the background worker after the post-grant restart.
  $('ready').hidden = !(granted.length && location.hash === '#ready');
});
chrome.permissions.onAdded.addListener(render);
chrome.permissions.onRemoved.addListener(render);
