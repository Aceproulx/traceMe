(function() {
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

  // Listen for messages from the side panel
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_SCRIPTS') {
      sendResponse({ scripts: getScripts(), url: window.location.href });
    }
  });
})();
