chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Badge severity colors
const SEVERITY_COLORS = {
  HIGH: '#ff2e63',
  MEDIUM: '#ff9f43',
  LOW: '#ffd32a'
};

// Track Angular state per tab
const tabAngularState = {};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Existing: fetch external scripts for side panel
  if (message.type === 'FETCH_EXTERNAL_SCRIPT') {
    fetch(message.url)
      .then(response => response.text())
      .then(text => sendResponse({ content: text }))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open
  }

  // Angular detection badge
  if (message.type === 'ANGULAR_DETECTED') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) return;

    tabAngularState[tabId] = message.summary;

    const badgeText = String(message.summary.total || '!');
    const badgeColor = SEVERITY_COLORS[message.summary.maxSeverity] || SEVERITY_COLORS.LOW;

    chrome.action.setBadgeText({ text: badgeText, tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId: tabId });
  }

  if (message.type === 'ANGULAR_NOT_DETECTED') {
    const tabId = sender.tab ? sender.tab.id : null;
    if (!tabId) return;

    delete tabAngularState[tabId];
    // Don't clear badge here — sidepanel.js may set its own badge for script count
  }
});

// Clear badge when tab is removed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabAngularState[tabId];
});

// Update badge when switching tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const state = tabAngularState[activeInfo.tabId];
  if (state) {
    const badgeText = String(state.total || '!');
    const badgeColor = SEVERITY_COLORS[state.maxSeverity] || SEVERITY_COLORS.LOW;
    chrome.action.setBadgeText({ text: badgeText, tabId: activeInfo.tabId });
    chrome.action.setBadgeBackgroundColor({ color: badgeColor, tabId: activeInfo.tabId });
  }
});
