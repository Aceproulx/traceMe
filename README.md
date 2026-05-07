# TraceMe - Bug Bounty JS Tool

A Chrome extension for bug bounty hunters to identify dangerous JS sinks and trace variable definitions/references.

## Features
- **Dangerous Sink Detection**: Automatically scans JS for functions like `eval`, `innerHTML`, `document.write`, etc.
- **Variable Tracing**: Click any variable in the code viewer to see its definition and all references. Works on minified code via AST analysis.
- **Code Beautifier**: Built-in "Format" button to prettify minified code for better readability.
- **Side Panel UI**: Persistent UI that stays open while you browse.
- **Support for External Scripts**: Automatically fetches and analyzes external JS files.

## Installation
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select the `traceme` project directory.
5. Click the extension icon to open the side panel.

## Usage
1. Navigate to a website you want to analyze.
2. Open the TraceMe side panel.
3. Select a script from the dropdown.
4. Review the "Dangerous Sinks" list or browse the code.
5. Click on variables to trace their definitions and usages.
