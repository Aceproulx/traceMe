const appContainer = document.querySelector('.app-container');
let currentScripts = [];
let currentCode = '';
let currentUrl = '';
let ast = null;
let lastState = { url: '', line: 0 };

const sinkRegexInput = document.getElementById('sink-regex');
const scriptSelector = document.getElementById('script-selector');
const sinkList = document.getElementById('sink-list');
const sinkCountBadge = document.getElementById('sink-count');
const codeViewer = document.getElementById('code-viewer');
const scriptNameDisplay = document.getElementById('script-name-display');
const refreshBtn = document.getElementById('refresh-btn');
const tracePanel = document.getElementById('trace-panel');
const traceList = document.getElementById('trace-list');
const traceTarget = document.getElementById('trace-target');
const liveValueEl = document.getElementById('live-value');
const closeTraceBtn = document.getElementById('close-trace');

// Initialize
async function init() {
    const state = await chrome.storage.local.get(['lastUrl', 'lastLine']);
    lastState = { url: state.lastUrl || '', line: state.lastLine || 0 };
    refreshScripts();
}

// Listen for tab updates to auto-refresh
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
        refreshScripts();
    }
});

// Listen for tab activation (switching tabs)
chrome.tabs.onActivated.addListener(() => {
    refreshScripts();
});

refreshBtn.addEventListener('click', refreshScripts);

async function refreshScripts(retryCount = 0) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || tab.url.startsWith('chrome://')) {
        updateScriptSelector();
        return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'GET_SCRIPTS' }, (response) => {
        if (chrome.runtime.lastError) {
            // Content script might not be ready yet, retry
            if (retryCount < 5) {
                console.log('Content script not ready, retrying...', retryCount);
                setTimeout(() => refreshScripts(retryCount + 1), 500);
            } else {
                console.error('Failed to connect to content script after retries');
                updateScriptSelector();
            }
            return;
        }
        if (response) {
            currentUrl = response.url;
            currentScripts = response.scripts;
            updateScriptSelector();
            
            // Update extension badge
            chrome.action.setBadgeText({ text: currentScripts.length.toString() });
            chrome.action.setBadgeBackgroundColor({ color: '#7000ff' });
        }
    });
}

function updateScriptSelector() {
    scriptSelector.innerHTML = '<option value="">-- Select a Script --</option>';
    currentScripts.forEach((script, index) => {
        const option = document.createElement('option');
        option.value = script.id;
        if (script.type === 'external') {
            const fileName = script.url.split('/').pop() || script.url;
            option.textContent = `JS: ${fileName}`;
        } else {
            option.textContent = `Inline Script #${index + 1}`;
        }
        scriptSelector.appendChild(option);
    });

    // Auto-select script
    if (currentScripts.length > 0) {
        const targetUrl = lastState.url || currentScripts[0].url;
        const scriptToLoad = currentScripts.find(s => s.url === targetUrl) || currentScripts[0];
        
        if (!currentCode || (scriptToLoad && scriptToLoad.url !== currentUrl)) {
            scriptSelector.value = scriptToLoad.id;
            loadScript(scriptToLoad.id, lastState.line);
            // Reset last line after first load
            lastState.line = 0;
        }
    }
}

async function loadScript(scriptId, targetLine = 0) {
    const script = currentScripts.find(s => s.id === scriptId);
    if (!script) return;

    chrome.storage.local.set({ lastUrl: script.url });

    if (script.type === 'external') {
        fetchAndDisplay(script.url, targetLine);
    } else {
        currentCode = js_beautify(script.content, { 
            indent_size: 2,
            space_in_empty_paren: true 
        });
        displayCode(currentCode, 'Inline Script');
        if (targetLine) goToLine(targetLine);
    }
}

scriptSelector.addEventListener('change', (e) => {
    if (e.target.value) loadScript(e.target.value);
});

async function fetchAndDisplay(url, targetLine = 0) {
    scriptNameDisplay.textContent = url.split('/').pop() || url;
    currentUrl = url;
    
    try {
        chrome.runtime.sendMessage({ type: 'FETCH_EXTERNAL_SCRIPT', url }, (response) => {
            if (response.error) {
                codeViewer.textContent = `Error fetching script: ${response.error}`;
                return;
            }
            
            // Auto-beautify
            currentCode = js_beautify(response.content, { 
                indent_size: 2,
                space_in_empty_paren: true 
            });

            displayCode(currentCode, url);
            if (targetLine) goToLine(targetLine);
        });
    } catch (err) {
        codeViewer.textContent = `Error: ${err.message}`;
    }
}

function displayCode(code, name) {
    currentCode = code;
    scriptNameDisplay.textContent = name;
    
    // Parse AST
    try {
        ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
    } catch (e) {
        console.warn('Acorn parse failed, trying script mode', e);
        try {
            ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
        } catch (e2) {
            console.error('Final Acorn parse failure', e2);
            ast = null;
        }
    }

    renderCodeWithHighlights(code);
    findSinks(code);
}

function renderCodeWithHighlights(code) {
    codeViewer.innerHTML = '';
    
    // Use Prism for syntax highlighting
    const highlightedCode = Prism.highlight(code, Prism.languages.javascript, 'javascript');
    const lines = highlightedCode.split('\n');
    const regex = new RegExp(sinkRegexInput.value, 'g');

    lines.forEach((line, index) => {
        const lineDiv = document.createElement('div');
        lineDiv.className = 'code-line';
        lineDiv.id = `line-${index + 1}`;

        // Create a temporary element to hold the highlighted HTML
        const temp = document.createElement('div');
        temp.innerHTML = line || ' '; // Handle empty lines

        // 1. First, identify and mark existing tokens
        temp.querySelectorAll('.token').forEach(token => {
            const text = token.textContent;
            
            // Highlight Sinks
            if (text.match(regex)) {
                token.classList.add('highlight-sink');
            }

            // Exclude non-variable tokens
            const isExcluded = token.classList.contains('keyword') || 
                              token.classList.contains('string') || 
                              token.classList.contains('comment') ||
                              token.classList.contains('operator') ||
                              token.classList.contains('punctuation');
            
            if (!isExcluded && !token.classList.contains('property')) {
                token.classList.add('clickable-variable');
            }
        });

        // 2. Now, find text nodes (content not caught by Prism tokens) and wrap potential variables
        const walker = document.createTreeWalker(temp, NodeFilter.SHOW_TEXT, null, false);
        let textNode;
        const nodesToReplace = [];
        while (textNode = walker.nextNode()) {
            if (textNode.parentElement.classList.contains('token')) continue;
            nodesToReplace.push(textNode);
        }

        nodesToReplace.forEach(node => {
            const text = node.nodeValue;
            const newSpan = document.createElement('span');
            // Wrap words in clickable spans
            newSpan.innerHTML = text.replace(/[a-zA-Z0-9_$]+/g, (match) => {
                if (match.match(regex)) {
                    return `<span class="token highlight-sink">${match}</span>`;
                }
                // Check if it's a property (preceded by a dot in the raw text)
                // This is hard to do here, so we'll just allow it for now to ensure "everything is clickable"
                return `<span class="clickable-variable">${match}</span>`;
            });
            node.parentNode.replaceChild(newSpan, node);
        });

        lineDiv.innerHTML = temp.innerHTML;
        codeViewer.appendChild(lineDiv);
    });
}

// Global click delegation for variables
codeViewer.addEventListener('click', (e) => {
    const target = e.target.closest('.clickable-variable');
    if (target) {
        handleVariableClick(target.textContent, target);
    }
});

function findSinks(code) {
    const regex = new RegExp(sinkRegexInput.value, 'g');
    const lines = code.split('\n');
    const sinks = [];

    lines.forEach((line, index) => {
        let match;
        while ((match = regex.exec(line)) !== null) {
            sinks.push({
                func: match[0],
                line: index + 1,
                content: line.trim().substring(0, 50) + '...'
            });
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
        li.innerHTML = `
            <span class="sink-func">${sink.func}</span>
            <span class="sink-line">Line ${sink.line}: ${escapeHtml(sink.content)}</span>
        `;
        li.onclick = () => {
            clearLineHighlights();
            const lineEl = document.getElementById(`line-${sink.line}`);
            if (lineEl) {
                lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                lineEl.classList.add('active-line-sink');
            }
        };
        sinkList.appendChild(li);
    });
}

function handleVariableClick(word, element) {
    if (!ast) return;
    
    // Find all occurrences of this word in the AST
    const refs = [];
    let definition = null;

    acorn.walk.simple(ast, {
        Identifier(node) {
            if (node.name === word) {
                refs.push(node);
            }
        },
        VariableDeclarator(node) {
            if (node.id.type === 'Identifier' && node.id.name === word) {
                definition = node.id;
            }
        },
        FunctionDeclaration(node) {
            if (node.id && node.id.name === word) {
                definition = node.id;
            }
        },
        ClassDeclaration(node) {
            if (node.id && node.id.name === word) {
                definition = node.id;
            }
        }
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
        li.onclick = (e) => {
            document.querySelectorAll('.trace-item.active').forEach(el => el.classList.remove('active'));
            e.currentTarget.classList.add('visited', 'active');
            goToLine(defLine);
        };
        traceList.appendChild(li);
    }

    const uniqueLines = new Set();
    refs.forEach(ref => {
        const line = getLineNumber(ref.start);
        if (def && line === getLineNumber(def.start)) return;
        uniqueLines.add(line);
    });

    uniqueLines.forEach(line => {
        const li = document.createElement('li');
        li.className = 'trace-item';
        li.textContent = `Reference: Line ${line}`;
        li.onclick = (e) => {
            document.querySelectorAll('.trace-item.active').forEach(el => el.classList.remove('active'));
            e.currentTarget.classList.add('visited', 'active');
            goToLine(line);
        };
        traceList.appendChild(li);
    });

    tracePanel.classList.remove('hidden');
    appContainer.classList.add('tracing-active');
    
    // Highlight all instances of this word in the viewer
    highlightTracedWord(word);

    // Get live value from page
    updateLiveValue(word);

    // Auto-scroll to definition if it exists
    if (defLine) {
        goToLine(defLine);
    }
}

function highlightTracedWord(word) {
    // Clear any previous word highlights
    document.querySelectorAll('.traced-variable-highlight').forEach(el => {
        el.classList.remove('traced-variable-highlight');
    });

    // Find all spans containing exactly this word and highlight them
    document.querySelectorAll('.clickable-variable').forEach(el => {
        if (el.textContent === word) {
            el.classList.add('traced-variable-highlight');
        }
    });
}

async function updateLiveValue(word) {
    liveValueEl.textContent = 'Fetching...';
    liveValueEl.title = '';

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.id) {
            liveValueEl.textContent = 'N/A';
            return;
        }

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: (varName) => {
                try {
                    let val = window[varName];
                    if (val === undefined) {
                        try { val = eval(varName); } catch(e) {}
                    }
                    if (val === undefined) return 'undefined';
                    if (val === null) return 'null';
                    if (typeof val === 'function') return '[Function]';
                    if (typeof val === 'object') {
                        try { return JSON.stringify(val).substring(0, 100); }
                        catch(e) { return '[Object]'; }
                    }
                    return String(val);
                } catch (e) { return 'N/A'; }
            },
            args: [word]
        }, (results) => {
            if (chrome.runtime.lastError || !results || !results[0]) {
                liveValueEl.textContent = 'N/A';
                return;
            }
            const val = results[0].result;
            liveValueEl.textContent = val;
            liveValueEl.title = val;
        });
    } catch (err) {
        liveValueEl.textContent = 'N/A';
    }
}

function getLineNumber(offset) {
    return currentCode.substring(0, offset).split('\n').length;
}

function clearLineHighlights() {
    document.querySelectorAll('.active-line-trace, .active-line-sink').forEach(el => {
        el.classList.remove('active-line-trace', 'active-line-sink');
    });
}

function clearAllHighlights() {
    clearLineHighlights();
    document.querySelectorAll('.traced-variable-highlight').forEach(el => {
        el.classList.remove('traced-variable-highlight');
    });
}

function goToLine(line) {
    clearLineHighlights();
    const lineEl = document.getElementById(`line-${line}`);
    if (lineEl) {
        lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        lineEl.classList.add('active-line-trace');
        // Remember last line
        chrome.storage.local.set({ lastLine: line });
    }
}

closeTraceBtn.onclick = () => {
    tracePanel.classList.add('hidden');
    appContainer.classList.remove('tracing-active');
    clearAllHighlights();
};

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

init();
