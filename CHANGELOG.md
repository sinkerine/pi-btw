# Changelog

## 0.1.0

- Add read-only BTW and Side commands with a TUI overlay and independent concurrent model requests.
- Capture exact completed parent requests, preserve tool declarations and automatically pin every question to the latest finished turn.
- Keep structured side history across rebases and persistent Pi restarts; refuse missing/corrupt context.
- Add explicit Inject/Summarize, cancellation, tangent/new thread modes and model/thinking overrides.
- Export the versioned host event contract and repeatable synchronization.
- Verify final OpenAI/Anthropic request serialization with real Pi 1.4.0; provide isolated live-cache measurement against the pinned dbachelder 0.8.1 baseline.
