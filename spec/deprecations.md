# Specification Deprecations & Removals

This document lists fields, methods, or capability flags that are scheduled for deprecation or removal.

| Feature / Field | Deprecated In | Target Removal Version | Alternative / Replacement | Notes |
|---|---|---|---|---|
| *(None)* | - | - | - | Initial v0.1.0 release has no deprecated fields. |

## Deprecation Policy

1. Any field marked for deprecation must remain supported for at least **6 months** after the release that introduces the deprecation before it can be removed. The window is measured in calendar time from the deprecation announcement release, not from an arbitrary version cycle.
2. The 6-month window is a binding guarantee from specification **v1.0.0** onward. During the pre-1.0 (0.x) series the same rule applies by convention, but removal may be coordinated across the SDK and TCK without waiting out the full window when a breaking change is otherwise required.
3. Deprecated fields will trigger warnings in compliance test runs.
4. Any deprecation that adds a replacement must keep the replacement available for at least one minor release before the deprecated field is removed.
