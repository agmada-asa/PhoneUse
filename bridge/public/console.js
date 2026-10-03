/** Drives the loopback console without storing screen data or pairing secrets in browser storage. */
const csrf = document.querySelector('meta[name="phoneuse-csrf"]').content;
const connection = document.getElementById('connection');
const message = document.getElementById('message');
let busy = false;
let latestStatus = { connected: false };

/** Calls only this origin with a per-install anti-CSRF credential; errors remain readable. */
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-PhoneUse-CSRF': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'The bridge request failed.');
  return result.type === 'result' && result.ok ? result.result : result;
}

/** Shows action feedback without interpreting phone text as HTML. */
function feedback(text, error = false) { message.textContent = text; message.classList.toggle('error', error); }

/** Derives enabled controls from the current phone consent state and pending action. */
function updateButtons() {
  const ready = latestStatus.connected && latestStatus.status?.accessibilityEnabled && latestStatus.status?.controlEnabled;
  document.querySelectorAll('#actions button').forEach(button => { button.disabled = !ready || busy; });
  document.getElementById('disconnect').disabled = !latestStatus.connected;
}

/** Refreshes state without overwriting explicit action results or errors. */
async function refresh() {
  try {
    latestStatus = await api('/api/status');
    if (!latestStatus.connected || !latestStatus.status?.controlEnabled) clearScreen();
    connection.textContent = latestStatus.connected ? 'Phone connected' : 'No phone connected';
    const status = latestStatus.status;
    const label = latestStatus.device?.name ?? 'Android phone';
    document.getElementById('device-state').textContent = !latestStatus.connected ? 'Waiting for a phone.' : !status?.accessibilityEnabled ? `${label}: enable accessibility in Android settings.` : !status?.controlEnabled ? `${label}: enable control in PhoneUse.` : `${label}: control enabled. Leave protected apps before testing.`;
  } catch { connection.textContent = 'Bridge unavailable'; latestStatus = { connected: false }; clearScreen(); document.getElementById('device-state').textContent = 'Restart the bridge, then reload this page.'; }
  updateButtons();
}

/** Clears retained phone data immediately after a disconnect or failed observation. */
function clearScreen() { document.getElementById('screen').removeAttribute('src'); document.getElementById('screen-result').hidden = true; document.getElementById('text-result').hidden = true; document.getElementById('result').textContent = ''; }

/** Executes a single action and lets the operator explicitly inspect its result. */
async function run(method, params = {}) {
  busy = true; updateButtons(); feedback('Waiting for the phone…');
  try {
    const result = await api('/api/command', { method, params });
    clearScreen();
    if (method === 'screenshot') {
      document.getElementById('screen').src = `data:${result.mimeType};base64,${result.data}`;
      document.getElementById('dimensions').textContent = `Image: ${result.width} × ${result.height} pixels. Tap tools use the display dimensions returned by Read screen.`;
      document.getElementById('screen-result').hidden = false;
    } else { document.getElementById('result').textContent = JSON.stringify(result, null, 2); document.getElementById('text-result').hidden = false; }
    feedback(method === 'snapshot' || method === 'screenshot' ? 'Screen captured.' : 'Action completed. Read the screen to verify the result.');
  } catch (error) { clearScreen(); feedback(error.message, true); }
  finally { busy = false; await refresh(); }
}

document.querySelectorAll('[data-method]').forEach(button => button.addEventListener('click', () => { void run(button.dataset.method); }));
document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => { void run('global_action', { action: button.dataset.action }); }));
document.getElementById('disconnect').addEventListener('click', async () => { try { await api('/api/disconnect', {}); clearScreen(); feedback('Phone disconnected. Reconnect from the phone when ready.'); await refresh(); } catch (error) { feedback(error.message, true); } });
document.getElementById('reveal').addEventListener('click', async () => {
  try { const pairing = await api('/api/pairing'); document.getElementById('pair-code').value = pairing.code; document.getElementById('pairing').hidden = false; document.getElementById('address').textContent = pairing.url; document.getElementById('reveal').hidden = true; }
  catch (error) { feedback(error.message, true); }
});
document.getElementById('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(document.getElementById('pair-code').value); feedback('Pairing code copied. Paste it into PhoneUse on your phone.'); } catch { document.getElementById('pair-code').select(); feedback('Select and copy the pairing code manually.'); } });
void refresh();
setInterval(() => { void refresh(); }, 2000);
document.getElementById('address').textContent = 'Use the computer address included in the pairing code.';
