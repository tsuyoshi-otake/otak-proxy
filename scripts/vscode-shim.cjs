// Minimal runtime shim for running non-UI tests in plain Node.
// VS Code extension host provides the real `vscode` module; unit tests don't.

const Module = require('module');

function createNoopOutputChannel() {
  return {
    name: 'otak-proxy(unit)',
    append: () => {},
    appendLine: () => {},
    clear: () => {},
    show: () => {},
    hide: () => {},
    dispose: () => {},
  };
}

const vscodeStub = {
  window: {
    createOutputChannel: () => createNoopOutputChannel(),
    createStatusBarItem: () => ({
      alignment: 1,
      priority: 0,
      text: '',
      tooltip: '',
      command: undefined,
      backgroundColor: undefined,
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
      update: async () => undefined,
    }),
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose: () => {} }),
  },
  env: {
    language: 'en',
  },
  Uri: {
    file: (p) => ({ fsPath: p, path: p, toString: () => String(p) }),
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  ThemeColor: function ThemeColor(id) {
    this.id = String(id);
  },
  MarkdownString: function MarkdownString(value) {
    this.value = value ? String(value) : '';
    this.isTrusted = false;
  },
};

// Methods expected by production code.
vscodeStub.MarkdownString.prototype.appendMarkdown = function (md) {
  this.value += String(md);
  return this;
};
vscodeStub.MarkdownString.prototype.appendText = function (txt) {
  this.value += String(txt);
  return this;
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.apply(this, arguments);
};
