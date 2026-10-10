# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a security bug.

Include what you found, the affected version, and steps to reproduce. We will acknowledge the report, work on a fix, and coordinate disclosure with you.

## Scope

In scope:

- The installed hooks and hook runtime that run alongside Claude Code and other supported harnesses.
- The dispatcher and the routing it performs between agents and providers.
- The local secret store, including how values are written, read, and kept out of project files and logs.
- The VS Code extension host, webview messaging, and the standalone host.

Out of scope: vulnerabilities in third-party tools or services that TycoonAgents merely invokes, and issues that require an attacker to already control the user's machine or account.

## Supported versions

Security fixes are made against the latest release.
