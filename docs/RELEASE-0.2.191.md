# 0.2.191-dev

Adds **Media → Files**, an SD-card-only browser. Internal flash is not exposed.

- Up/Down (or `,`/`.`) selects an entry; Enter opens folders.
- Escape cancels a deletion first, otherwise goes up a folder or returns Home.
- D or Del asks to delete the selected file; only a separate Y confirms.
  Any other key cancels. The dialog scrolls long names and paths and warns that
  deletion is permanent. Folders are not deleted; there is no recursive delete.
- R refreshes. A folder listing is bounded to the first 128 valid entries and
  explicitly reports truncation. Refresh after cleanup to reveal further files.
- Deletion rechecks file existence, type, size and current-folder ownership.
  It is blocked while recording, playing, submitting, or storage/network work
  owns files. Background network work is suspended in this app.

Host regressions execute the actual browser, deletion handler and renderer against
an isolated fake filesystem. Tests cover navigation, cancellation, stale/missing
files, busy storage, directory/traversal rejection, one-shot confirmation and UI
bounds. No real device files are deleted during development or OTA publication.
Physical SD navigation and deletion acceptance remains a separate user check.

Retains the previous UI and current segmented Realtime reply-memory changes.
