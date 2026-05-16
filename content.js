(function() {
  // ============================================================
  // EXISTING: Script collection for JS Analyzer
  // ============================================================
  function getScripts() {
    const scripts = [];
    
    // Inline scripts
    document.querySelectorAll('script:not([src])').forEach((script, index) => {
      if (script.textContent.trim()) {
        scripts.push({
          id: `inline-${index}`,
          type: 'inline',
          content: script.textContent,
          url: `(inline script ${index})`
        });
      }
    });

    // External scripts
    document.querySelectorAll('script[src]').forEach((script, index) => {
      scripts.push({
        id: `external-${index}`,
        type: 'external',
        url: script.src
      });
    });

    return scripts;
  }

  // ============================================================
  // ANGULAR DETECTION ENGINE
  // ============================================================

  const HIGH_RISK_DIRECTIVES = [
    'ng-include',
    'ng-bind-html',
    'ng-init',
    'ng-switch'
  ];

  const MEDIUM_RISK_DIRECTIVES = [
    'ng-bind',
    'ng-click',
    'ng-submit',
    'ng-repeat',
    'ng-if',
    'ng-show',
    'ng-hide',
    'ng-class'
  ];

  const LOW_RISK_DIRECTIVES = [
    'ng-model',
    'ng-form',
    'ng-app',
    'ng-controller',
    'ng-attr-'
  ];

  const DANGEROUS_PATTERNS = [
    '$on.constructor',
    '$scope',
    '$root',
    '$injector',
    'constructor.prototype.constructor',
    '$http',
    '$event',
    '$event.constructor'
  ];

  const EXPRESSION_REGEX = /\{\{[^}]*\}\}|\{%[^%]*%\}/g;

  // --- 1. Framework Detection ---
  function detectAngularFramework() {
    const result = {
      detected: false,
      version: null,
      signals: []
    };

    // Check ng-app in DOM
    const ngAppEl = document.querySelector('[ng-app], [data-ng-app]');
    if (ngAppEl) {
      result.detected = true;
      result.signals.push('ng-app directive found');
    }

    // Check for angular global
    if (typeof window.angular !== 'undefined') {
      result.detected = true;
      result.signals.push('angular global object found');
      try {
        if (window.angular.version) {
          result.version = window.angular.version.full || window.angular.version;
        }
      } catch (e) {}
    }

    // Check for ng-* attributes anywhere
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      for (const attr of el.attributes) {
        if (attr.name.startsWith('ng-') || attr.name.startsWith('data-ng-')) {
          result.detected = true;
          if (!result.signals.includes('ng-* attributes found')) {
            result.signals.push('ng-* attributes found');
          }
          break;
        }
      }
      if (result.detected && result.signals.includes('ng-* attributes found')) break;
    }

    // Check for {{ }} or {% %} in page source
    const bodyHTML = document.body ? document.body.innerHTML : '';
    if (EXPRESSION_REGEX.test(bodyHTML)) {
      result.detected = true;
      result.signals.push('Template expressions found');
      EXPRESSION_REGEX.lastIndex = 0; // Reset regex
    }

    // Check for Angular service calls in scripts
    const scriptContent = getInlineScriptContent();
    const servicePatterns = ['$scope', '$on', '$injector', '$http', '$rootScope', 'angular.module'];
    for (const pat of servicePatterns) {
      if (scriptContent.includes(pat)) {
        result.detected = true;
        if (!result.signals.includes('Angular service calls in scripts')) {
          result.signals.push('Angular service calls in scripts');
        }
        break;
      }
    }

    return result;
  }

  function getInlineScriptContent() {
    let content = '';
    document.querySelectorAll('script:not([src])').forEach(script => {
      content += script.textContent + '\n';
    });
    return content;
  }

  // --- 2. Directive Scanning ---
  function scanDirectives() {
    const findings = [];
    const allElements = document.querySelectorAll('*');
    let elementIndex = 0;

    allElements.forEach(el => {
      elementIndex++;
      for (const attr of el.attributes) {
        const attrName = attr.name.replace(/^data-/, '');

        if (!attrName.startsWith('ng-')) continue;

        const severity = classifyDirective(attrName);
        if (!severity) continue;

        findings.push({
          directive: attrName,
          value: attr.value,
          severity: severity,
          element: {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: el.className ? el.className.split(/\s+/).filter(Boolean).slice(0, 3).join(', ') : null
          },
          domIndex: elementIndex,
          lineEstimate: estimateDomLine(el)
        });
      }
    });

    return findings;
  }

  function classifyDirective(name) {
    const normalized = name.replace(/^data-/, '');
    if (HIGH_RISK_DIRECTIVES.includes(normalized)) return 'HIGH';
    if (MEDIUM_RISK_DIRECTIVES.includes(normalized)) return 'MEDIUM';
    // Check low risk (includes wildcard ng-attr-*)
    for (const pat of LOW_RISK_DIRECTIVES) {
      if (pat.endsWith('-')) {
        if (normalized.startsWith(pat)) return 'LOW';
      } else if (normalized === pat) {
        return 'LOW';
      }
    }
    // Any other ng-* directive is LOW
    if (normalized.startsWith('ng-')) return 'LOW';
    return null;
  }

  function estimateDomLine(el) {
    // Walk backwards through siblings and parents to estimate position
    try {
      const html = document.documentElement.outerHTML;
      const tag = el.outerHTML.substring(0, Math.min(80, el.outerHTML.length));
      const idx = html.indexOf(tag);
      if (idx !== -1) {
        return html.substring(0, idx).split('\n').length;
      }
    } catch (e) {}
    return null;
  }

  // --- 3. Expression Extraction ---
  function extractExpressions() {
    const expressions = [];
    const seen = new Set();

    // Scan body innerHTML for expressions
    const bodyHTML = document.body ? document.body.innerHTML : '';
    let match;
    const regex = new RegExp(EXPRESSION_REGEX.source, 'g');

    while ((match = regex.exec(bodyHTML)) !== null) {
      const expr = match[0];
      if (seen.has(expr)) continue;
      seen.add(expr);

      // Extract inner content
      const inner = expr.replace(/^\{\{|\}\}$|\{%|%\}$/g, '').trim();

      // Determine context
      const contextStart = Math.max(0, match.index - 100);
      const contextEnd = Math.min(bodyHTML.length, match.index + expr.length + 100);
      const context = bodyHTML.substring(contextStart, contextEnd);

      // Find parent element
      let parentTag = 'unknown';
      const beforeExpr = bodyHTML.substring(Math.max(0, match.index - 500), match.index);
      const tagMatch = beforeExpr.match(/<(\w+)[^>]*>[^<]*$/);
      if (tagMatch) parentTag = tagMatch[1].toLowerCase();

      expressions.push({
        full: expr,
        inner: inner,
        parentElement: parentTag,
        contextSnippet: sanitizeContext(context),
        containsVariable: /[a-zA-Z_$]/.test(inner),
        containsFunctionCall: /\(/.test(inner),
        containsFilter: /\|/.test(inner)
      });
    }

    return expressions;
  }

  function sanitizeContext(text) {
    return text.replace(/<[^>]*>/g, '').trim().substring(0, 120);
  }

  // --- 4. Scope/Service Pattern Detection ---
  function detectScopePatterns() {
    const findings = [];
    const scriptContent = getInlineScriptContent();
    const scripts = [];

    // Collect inline scripts
    document.querySelectorAll('script:not([src])').forEach((script, idx) => {
      if (script.textContent.trim()) {
        scripts.push({
          type: 'inline',
          content: script.textContent,
          source: `inline-script-${idx}`
        });
      }
    });

    // Scan each script for dangerous patterns
    scripts.forEach(script => {
      const lines = script.content.split('\n');
      lines.forEach((line, lineIdx) => {
        DANGEROUS_PATTERNS.forEach(pattern => {
          if (line.includes(pattern)) {
            findings.push({
              pattern: pattern,
              line: lineIdx + 1,
              context: line.trim().substring(0, 150),
              scriptSource: script.source,
              scriptType: script.type,
              severity: classifyPattern(pattern)
            });
          }
        });
      });
    });

    return findings;
  }

  function classifyPattern(pattern) {
    const highPatterns = ['$on.constructor', 'constructor.prototype.constructor', '$event.constructor'];
    const mediumPatterns = ['$scope', '$injector', '$event', '$root', '$http'];
    if (highPatterns.includes(pattern)) return 'HIGH';
    if (mediumPatterns.includes(pattern)) return 'MEDIUM';
    return 'LOW';
  }

  // --- 5. Connection Detection ---
  function detectConnections() {
    const connections = [];
    const urlParams = new URLSearchParams(window.location.search);
    const paramNames = Array.from(urlParams.keys());

    if (paramNames.length === 0) return connections;

    const allElements = document.querySelectorAll('*');
    allElements.forEach(el => {
      for (const attr of el.attributes) {
        const attrName = attr.name.replace(/^data-/, '');
        if (!attrName.startsWith('ng-')) continue;

        const value = attr.value;
        paramNames.forEach(param => {
          if (value.includes(param)) {
            connections.push({
              urlParam: param,
              urlValue: urlParams.get(param),
              directive: attrName,
              directiveValue: value,
              element: el.tagName.toLowerCase(),
              elementId: el.id || null
            });
          }
        });
      }
    });

    return connections;
  }

  // --- 6. Full Analysis ---
  function runAngularAnalysis() {
    const framework = detectAngularFramework();

    if (!framework.detected) {
      return { detected: false };
    }

    const directives = scanDirectives();
    const expressions = extractExpressions();
    const scopePatterns = detectScopePatterns();
    const connections = detectConnections();

    // Compute severity counts
    const highCount = directives.filter(d => d.severity === 'HIGH').length +
                      scopePatterns.filter(p => p.severity === 'HIGH').length;
    const mediumCount = directives.filter(d => d.severity === 'MEDIUM').length +
                        scopePatterns.filter(p => p.severity === 'MEDIUM').length;
    const lowCount = directives.filter(d => d.severity === 'LOW').length +
                     scopePatterns.filter(p => p.severity === 'LOW').length;

    const totalCount = directives.length + expressions.length + scopePatterns.length;

    let maxSeverity = 'LOW';
    if (highCount > 0) maxSeverity = 'HIGH';
    else if (mediumCount > 0) maxSeverity = 'MEDIUM';

    return {
      detected: true,
      version: framework.version,
      signals: framework.signals,
      directives: directives,
      expressions: expressions,
      scopePatterns: scopePatterns,
      connections: connections,
      summary: {
        total: totalCount,
        high: highCount,
        medium: mediumCount,
        low: lowCount,
        expressionCount: expressions.length,
        scopeCount: scopePatterns.length,
        connectionCount: connections.length,
        maxSeverity: maxSeverity
      }
    };
  }

  // --- 7. Auto-detection on page load ---
  function autoDetectAndReport() {
    // Small delay to let Angular bootstrap
    setTimeout(() => {
      try {
        const result = runAngularAnalysis();
        if (result.detected) {
          chrome.runtime.sendMessage({
            type: 'ANGULAR_DETECTED',
            summary: result.summary,
            url: window.location.href
          });
        } else {
          chrome.runtime.sendMessage({
            type: 'ANGULAR_NOT_DETECTED',
            url: window.location.href
          });
        }
      } catch (e) {
        console.error('[TraceMe] Angular detection error:', e);
      }
    }, 1500);
  }

  autoDetectAndReport();

  // ============================================================
  // MESSAGE LISTENERS
  // ============================================================
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_SCRIPTS') {
      sendResponse({ scripts: getScripts(), url: window.location.href });
    }

    if (message.type === 'GET_ANGULAR_DATA') {
      const result = runAngularAnalysis();
      sendResponse(result);
    }

    if (message.type === 'GET_PAGE_HTML') {
      sendResponse({ html: document.documentElement.outerHTML });
    }

    if (message.type === 'HIGHLIGHT_ELEMENT') {
      // Highlight an element in the page based on directive info
      highlightElementInPage(message.data);
      sendResponse({ ok: true });
    }
  });

  // --- Page Highlight Helper ---
  function highlightElementInPage(data) {
    // Remove previous highlights
    document.querySelectorAll('.traceme-angular-highlight').forEach(el => {
      el.style.outline = '';
      el.style.outlineOffset = '';
      el.classList.remove('traceme-angular-highlight');
    });

    if (!data || !data.directive) return;

    const selector = `[${data.directive}]`;
    const matches = document.querySelectorAll(selector);
    matches.forEach(el => {
      if (data.value && el.getAttribute(data.directive) !== data.value) return;
      el.classList.add('traceme-angular-highlight');
      el.style.outline = '3px solid #ff2e63';
      el.style.outlineOffset = '2px';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Auto-remove highlight after 5s
      setTimeout(() => {
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.classList.remove('traceme-angular-highlight');
      }, 5000);
    });
  }
})();
