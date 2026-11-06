# Refresh and rollout check

Used by **refresh**, **ship** (after the release steps), and **check** (read-only). A "copy" is any deployed projection of canonical files: a worktree's agent directory, a generated harness location, or similar. The bundle's own README or setup script tells you the mapping from a canonical file to its copy path. Read it; never run it to learn.

## Classify every copy file

For each canonical file that has a mapped copy path, compare the copy with the canonical file's current content:

| State | Rule |
|---|---|
| **current** | identical to the canonical file |
| **stale** | differs, and the copy's content is byte-identical to the canonical file at some earlier commit in its history (`git log` for the path, then compare each earlier version) |
| **locally modified** | differs and matches no earlier version of the canonical file |
| **absent** | the mapping is known, the copy's root exists and is verified, the canonical source is a regular file, and the target path does not exist |
| **unverified** | the mapping is unknown, the copy root is missing, a symlink, or outside the expected location, a target or any ancestor is a symlink or a non-directory, the target path escapes the copy root, or history cannot be read |

A copy is **stale** only when every differing file is stale or absent. If any file is modified or unverified, report the copy as modified or unverified and refresh none of it. Absent files alone never block a refresh. Files that exist only in the copy are reported and never touched.

## Check (read-only)

Report per repository: uncommitted changes, ahead and behind its upstream (after `git fetch`), and whether each parent pointer matches the child's tip. Report per copy its state from the table above. Change nothing and list the commands that would fix each finding.

## Refresh (after approval)

For each approved copy, replace its stale files and add its absent files with the canonical content, preserving file mode. The preview lists every addition and every directory that must be created. One file at a time, writing to a temporary file in the same directory and renaming it into place. Never delete, never overwrite a modified file, never follow or replace a symlink, and never run a setup or bootstrap hook that removes and recreates the destination.

Before writing each addition, re-check that the target and its ancestors are still absent or plain directories. Create it without replacing anything (for example a hard link or `mv -n` from the temporary file), and create only the previewed directories. If the target has appeared since the preview, stop and report it rather than overwriting. If a write fails, stop and report the files already refreshed.

Re-run the classification afterward. A refreshed copy must classify as current; anything else is reported as a failure.

## Running sessions

Updated files do not change what a running agent or service already loaded. After refreshing, state which sessions or services may need a reload or restart and why. Do not restart or reload anything unless the approved list included it.
