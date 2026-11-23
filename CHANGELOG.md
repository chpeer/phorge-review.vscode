# Change Log

## [1.0.1] - 2026-11-23
### Fixed
- User avatars now load. Phabricator only serves uploaded files to logged-in browser sessions, so profile pictures are now downloaded via Conduit
- The diff editor no longer shows duplicate previous/next change buttons

## [1.0.0] - 2026-11-12
### Changed
- New sidebar icon: a disc with the cogwheel cut out, so it no longer looks like a settings icon
- Add screenshots and a compatibility note to the README
- Use the SPDX licence identifier `Apache-2.0`
- Require VS Code 1.145 or newer (`engines.vscode` is now `^1.145.0`)

## [0.1.0] - 2026-11-11
### Added
- Initial release
- List revisions awaiting review
- Check a revision's diff out onto a local branch
- Browse changed files as a tree or flat list and open them as diffs
- View, add and publish inline comments
- Comment, accept or request changes on a revision
