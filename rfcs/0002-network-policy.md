# RFC 0002: Network Access Policies

- **Author**: Palmshed Team
- **Status**: Accepted
- **Created**: 2026-08-07

## Summary
Define standard network policy abstraction levels (`disabled`, `allow`, `proxy`) for isolated sandbox runtime instances.

## Design
- `disabled`: Complete network isolation. Outbound and inbound traffic are blocked.
- `allow`: Unrestricted outbound network access.
- `proxy`: Network access routed strictly through an explicit HTTP/HTTPS proxy.
