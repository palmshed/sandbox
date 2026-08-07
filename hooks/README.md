# Git Guardrail Hooks

This directory contains lightweight local guardrails:

- `pre-commit`: Linting, JSON validation, and file size checks.
- `commit-msg`: Conventional commit format verification.
- `pre-push`: Fast test execution and specification sync verification.

Run `npm run hooks:install` or `./scripts/install-hooks` to enable hooks in your local clone.
