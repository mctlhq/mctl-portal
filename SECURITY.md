# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Email:** security@mctl.ai

**Response time:** We will acknowledge your report within 48 hours and provide a detailed response within 5 business days.

**Please do NOT:**
- Open a public GitHub issue for security vulnerabilities
- Disclose the vulnerability publicly before it has been addressed

## Supported Versions

Only the latest release is supported with security updates.

## Scope

This policy applies to all repositories in the mctlhq organization:
- mctl-api
- mctl-web
- mctl-docs
- mctl-gitops
- mctl-portal
- mctl-agent

## Content-Security-Policy (residual)

Live `app.mctl.ai` CSP comes from Backstage/Helmet defaults. It does **not**
allow `script-src 'unsafe-inline'`.

Backstage still requires two directives that we do not tighten:

- `style-src 'unsafe-inline'` — Material UI / JSS emit inline styles. Removing it blanks the UI.
- `script-src 'unsafe-eval'` — webpack runtime. Removing it breaks the SPA.

Do not add `'unsafe-inline'` to `script-src`.
