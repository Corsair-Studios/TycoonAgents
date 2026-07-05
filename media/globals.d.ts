// Ambient declarations for the VS Code webview environment.
// These globals are injected by the VS Code webview host at runtime and are
// not defined anywhere in media/main.js itself — without this declaration,
// tsc --checkJs would (correctly) flag `acquireVsCodeApi` as undefined.
declare function acquireVsCodeApi(): any;
