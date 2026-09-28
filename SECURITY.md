# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub
issues — the tracker is public once this repository is public.

Report privately through **GitHub Security Advisories**:
[Report a vulnerability](https://github.com/Nuncio-hq/LilOS/security/advisories/new)
(the "Security" tab on this repository → "Report a vulnerability").

Please include as much of the following as you can:

- a description of the issue and its impact;
- steps to reproduce, or a proof of concept;
- the affected part (web/desktop/mobile app, relay, harness, docs, CI);
- any suggested remediation.

## What to expect

- We will acknowledge your report as soon as we can, and keep you informed as
  we investigate and fix.
- Please give us a reasonable window to remediate before disclosing publicly,
  and avoid accessing other users' data or degrading the service beyond what
  is needed to demonstrate the issue.

## Scope

LilOS is a prototype: source code, CI workflows, and the public site in
`site/`. The app runs against engines and machines you operate; findings
about third-party engines (e.g. Hermes) belong to their own projects.
