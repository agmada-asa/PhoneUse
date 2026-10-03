/**
 * Drives the loopback console: derives setup progress from the bridge status, runs single
 * phone actions, and shows their results. Screen data and pairing secrets stay in page memory only.
 */
const csrf = document.querySelector('meta[name="phoneuse-csrf"]').content;
const $ = (id) => document.getElementById(id);
const message = $('message');

/** How often the console polls the bridge for connection and consent changes. */
const REFRESH_MS = 2000;
/** Upper bound on screen elements listed in the result panel; the raw result keeps the rest. */
const MAX_LISTED_NODES = 200;
/** Ordered setup steps; the first one not yet done becomes the current step. */
const STEPS = ['pair', 'access', 'control', 'agent'];

let busy = false;
let latestStatus = { connected: false };
/** Null while the bridge answers; otherwise why it does not ('down' or 'stale' after a bridge restart). */
let bridgeIssue = null;
let currentStep = null;
let apkBusy = false;
let apkMessage = '';

/** Calls only this origin with a per-install anti-CSRF credential; errors remain readable. */
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'X-PhoneUse-CSRF': csrf,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error?.message ?? 'The bridge request failed.'), {
      status: response.status,
    });
  return result.type === 'result' && result.ok ? result.result : result;
}

/** Shows action feedback without interpreting phone text as HTML. */
function feedback(text, error = false) {
  message.textContent = text;
  message.classList.toggle('error', error);
}

/** Reports whether the phone is connected with accessibility and control both enabled. */
function isReady() {
  return Boolean(
    latestStatus.connected &&
    latestStatus.status?.accessibilityEnabled &&
    latestStatus.status?.controlEnabled,
  );
}

/** Opens one step's details and closes the rest. */
function expandOnly(step) {
  for (const id of STEPS) setExpanded(id, id === step);
}

/** Shows or hides a single step body and keeps its toggle's state announced. */
function setExpanded(step, open) {
  $(`step-${step}`).querySelector('.step-head').setAttribute('aria-expanded', String(open));
  $(`step-${step}-body`).hidden = !open;
}

/** Updates the step list, progress copy, and status pill from the latest bridge status. */
function renderSetup() {
  const status = latestStatus.status;
  const name = latestStatus.device?.name ?? 'your phone';
  const done = {
    pair: latestStatus.connected,
    access: latestStatus.connected && Boolean(status?.accessibilityEnabled),
    control: isReady(),
    agent: latestStatus.agentConfigured === true,
  };
  const labels = {
    agent: done.agent ? 'Configured' : 'Connect your agent',
    pair: done.pair
      ? `Connected to ${name}`
      : !bridgeIssue
        ? 'Waiting for your phone'
        : 'The bridge is not available',
    access: done.access ? 'On' : done.pair ? 'Turn it on in PhoneUse' : 'After pairing',
    control: done.control
      ? 'Allowed'
      : done.access
        ? 'Turn it on in PhoneUse'
        : 'After accessibility',
  };
  const next = STEPS.find((step) => !done[step]);
  for (const step of STEPS) {
    $(`step-${step}`).dataset.state = done[step] ? 'done' : step === next ? 'current' : 'todo';
    if (labels[step]) $(`step-${step}-status`).textContent = labels[step];
  }
  if (next !== currentStep) {
    currentStep = next;
    expandOnly(next);
  }

  const completed = ['pair', 'access', 'control'].filter((step) => done[step]).length;
  $('setup-heading').textContent = completed === 3 ? 'Your phone is ready' : 'Set up your phone';
  $('progress').textContent =
    bridgeIssue === 'stale'
      ? 'The bridge restarted. Reload this page to continue.'
      : bridgeIssue
        ? 'Start the bridge with npm start, then reload this page.'
        : completed === 3
          ? done.agent
            ? 'MCP is configured. Open a new agent session to load the phone tools.'
            : 'Try the controls, or connect your coding agent to start using the phone.'
          : `${completed} of 3 steps done. Control stays off until you allow it on the phone.`;

  const [tone, text] =
    bridgeIssue === 'stale'
      ? ['error', 'Reload this page']
      : bridgeIssue
        ? ['error', 'Bridge unavailable']
        : isReady()
          ? ['ok', 'Ready for control']
          : latestStatus.connected
            ? ['warn', 'Phone connected · control off']
            : ['neutral', 'No phone connected'];
  $('connection').dataset.tone = tone;
  $('connection-label').textContent = text;

  $('device-state').textContent =
    bridgeIssue === 'stale'
      ? 'Reload this page to reconnect to the bridge.'
      : bridgeIssue
        ? 'Start the bridge, then reload this page.'
        : !latestStatus.connected
          ? 'Waiting for a phone.'
          : !status?.accessibilityEnabled
            ? `${name} · turn on accessibility in PhoneUse.`
            : !status?.controlEnabled
              ? `${name} · allow control in PhoneUse to try actions.`
              : `${name} · control allowed. Leave PhoneUse before testing.`;

  renderAddress();
}

/** Explains which address the phone will dial, warning when no Wi-Fi address was found. */
function renderAddress() {
  if (!latestStatus.phoneUrl) return;
  let host;
  try {
    host = new URL(latestStatus.phoneUrl.replace(/^wss:/, 'https:')).host;
  } catch {
    return;
  }
  $('address').textContent = /^127\.|^\[?::1\]?/.test(host)
    ? "No Wi-Fi address was found. Restart the bridge with npm start -- --advertise followed by this computer's Wi-Fi IP."
    : `Your phone will connect to ${host}. Both devices must be on the same Wi-Fi network.`;
}

/** Enables controls only when the phone allows them and no action is pending. */
function updateButtons() {
  const ready = isReady();
  document.querySelectorAll('#actions button').forEach((button) => {
    button.disabled = !ready || busy;
  });
  $('disconnect').hidden = !latestStatus.connected;
  $('download-apk').disabled = Boolean(apkBusy || bridgeIssue || !latestStatus.apkAvailable);
  $('apk-status').textContent =
    apkMessage ||
    (bridgeIssue
      ? 'Reconnect to the console to download the app.'
      : latestStatus.apkAvailable
        ? 'Transfer the APK to your Android phone and open it to install, then pair below.'
        : 'Ask your agent to set up PhoneUse and prepare the Android app.');
}

/** Downloads the prepared APK with the console's CSRF credential, without putting secrets in a URL. */
async function downloadApk() {
  apkBusy = true;
  apkMessage = 'Downloading the Android app.';
  updateButtons();

  try {
    const response = await fetch('/api/apk', {
      headers: { 'X-PhoneUse-CSRF': csrf },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error?.message ?? 'The app download failed. Try again.');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'PhoneUse-debug.apk';
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    apkMessage = 'APK downloaded. Transfer it to your Android phone and open it to install.';
  } catch (error) {
    apkMessage =
      error.name === 'TimeoutError' ? 'The download timed out. Try again.' : error.message;
  } finally {
    apkBusy = false;
    updateButtons();
  }
}

/** Refreshes state without overwriting explicit action results or errors. */
async function refresh() {
  try {
    const wasConnected = latestStatus.connected;
    latestStatus = await api('/api/status');
    bridgeIssue = null;
    if (!isReady()) clearScreen();
    // Take the pairing secret off screen when a phone connects, but let the operator show it
    // again while connected, for example to pair a second phone or re-pair this one.
    if (latestStatus.connected && !wasConnected && !$('pairing').hidden) hidePairing();
  } catch (error) {
    bridgeIssue = error.status === 401 || error.status === 403 ? 'stale' : 'down';
    latestStatus = { connected: false };
    clearScreen();
  }
  renderSetup();
  updateButtons();
}

/** Clears retained phone data immediately after a disconnect or a stale observation. */
function clearScreen() {
  $('screen').removeAttribute('src');
  $('screen').hidden = true;
  $('viewer').dataset.empty = 'true';
  $('viewer-empty').hidden = false;
  $('dimensions').hidden = true;
  $('text-result').hidden = true;
  $('result').textContent = '';
  $('result-nodes').replaceChildren();
}

/** Shows a screenshot in the phone viewer. */
function showScreenshot(result) {
  $('screen').src = `data:${result.mimeType};base64,${result.data}`;
  $('screen').hidden = false;
  $('viewer').dataset.empty = 'false';
  $('viewer-empty').hidden = true;
  $('dimensions').textContent =
    `${result.width} × ${result.height} image. Tap coordinates use the display size from Read screen.`;
  $('dimensions').hidden = false;
}

/** Lists readable screen elements as plain text; phone content is never parsed as HTML. */
function showSnapshot(result) {
  const readable = result.nodes.filter((node) => node.text || node.description);
  $('result-summary').textContent =
    `${readable.length} labeled of ${result.nodes.length} elements in ${result.packageName} · display ${result.screen.width} × ${result.screen.height}${result.truncated ? ' · list truncated' : ''}`;
  const items = readable.slice(0, MAX_LISTED_NODES).map((node) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = node.text || node.description;
    item.append(label);
    const kind = node.editable
      ? 'Field'
      : node.clickable
        ? 'Button'
        : node.scrollable
          ? 'Scrolls'
          : '';
    if (kind) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = kind;
      item.append(tag);
    }
    return item;
  });
  if (!items.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No labeled elements on this screen.';
    items.push(empty);
  }
  $('result-nodes').replaceChildren(...items);
  $('result').textContent = JSON.stringify(result, null, 2);
  $('text-result').hidden = false;
}

/** Executes a single action and lets the operator inspect its result. */
async function run(method, params = {}) {
  busy = true;
  updateButtons();
  feedback('Waiting for the phone…');
  try {
    const result = await api('/api/command', { method, params });
    if (method === 'screenshot') {
      showScreenshot(result);
      feedback('Screenshot taken.');
    } else if (method === 'snapshot') {
      showSnapshot(result);
      feedback('Screen read.');
    } else {
      clearScreen();
      feedback('Done. Read the screen or take a screenshot to check the result.');
    }
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    await refresh();
  }
}

/** Hides the pairing secret and removes it from the page. */
function hidePairing() {
  $('pairing').hidden = true;
  $('pair-qr').removeAttribute('src');
  $('pair-code').value = '';
  $('reveal').textContent = 'Show pairing QR code';
  $('reveal').setAttribute('aria-expanded', 'false');
}

/** Copies text and confirms on the button itself, falling back to manual selection when denied. */
async function copy(button, text, fallbackElement) {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    fallbackElement?.select();
    button.textContent = 'Select and copy manually';
  }
  setTimeout(() => {
    button.textContent = label;
  }, 2000);
}

for (const step of STEPS) {
  const head = $(`step-${step}`).querySelector('.step-head');
  head.addEventListener('click', () =>
    setExpanded(step, head.getAttribute('aria-expanded') !== 'true'),
  );
}
document.querySelectorAll('[data-method]').forEach((button) =>
  button.addEventListener('click', () => {
    void run(button.dataset.method);
  }),
);
document.querySelectorAll('[data-action]').forEach((button) =>
  button.addEventListener('click', () => {
    void run('global_action', { action: button.dataset.action });
  }),
);
$('disconnect').addEventListener('click', async () => {
  try {
    await api('/api/disconnect', {});
    clearScreen();
    feedback('Phone disconnected. Reconnect from the phone when ready.');
    await refresh();
  } catch (error) {
    feedback(error.message, true);
  }
});
$('download-apk').addEventListener('click', () => {
  void downloadApk();
});
$('reveal').addEventListener('click', async () => {
  if (!$('pairing').hidden) {
    hidePairing();
    return;
  }
  $('reveal').disabled = true;
  $('pair-error').textContent = '';
  try {
    const pairing = await api('/api/pairing');
    $('pair-code').value = pairing.code;
    $('pair-qr').src = pairing.qrDataUrl;
    $('pairing').hidden = false;
    $('reveal').textContent = 'Hide pairing QR code';
    $('reveal').setAttribute('aria-expanded', 'true');
  } catch (error) {
    $('pair-error').textContent = error.message;
  } finally {
    $('reveal').disabled = false;
  }
});
$('copy').addEventListener('click', () => {
  void copy($('copy'), $('pair-code').value, $('pair-code'));
});
$('copy-mcp').addEventListener('click', () => {
  void copy($('copy-mcp'), $('mcp-command').textContent);
});

void refresh();
setInterval(() => {
  if (document.visibilityState === 'visible') void refresh();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refresh();
});
