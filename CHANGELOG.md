# Changelog

## 0.1.1

### Fixed
- Claude Code: text parts of a prompt are separated by a blank line, as for the other CLIs. They were joined with nothing in between.
- Claude Code's "There's an issue with the selected model" is reported as `UNKNOWN_MODEL` instead of `CLI_ERROR`.
- `getHarness(id, { refresh: true })` and `getHarnesses({ refresh: true })` also re-read the model catalog (Cursor's was kept for 10 minutes).
- Option types accept an explicit `undefined`, for projects with `exactOptionalPropertyTypes`.

### Changed
- `acceptsModel('claude', v)` accepts only `claude-…` names and Claude Code's aliases (`opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `default`, optionally with `[1m]`).
- `getModels()` returns the built-in catalogs (Claude Code, Codex, Gemini) even when the CLI is not installed.

### Added
- `ask()` option `imageListLabel`: the word before the list of image names for CLIs that read images from files. Default `"Images"`.
- `ask()` option `skipUnreadableImages`: leave out images that cannot be used instead of failing; `AskResult.skippedImages` lists them.

## 0.1.0

First release.
