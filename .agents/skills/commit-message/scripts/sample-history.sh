#!/bin/sh
# Print a deterministic sample of commit history for drafting a commit
# message that matches a repo's real conventions: subject grammar,
# subsystem prefixes, whether a body is expected, typical body length,
# and trailer format.
#
# Usage: sample-history.sh --repo <repo-root> [<changed-path>...]
#
# --repo is required and names the repository being committed to.
# History is always sampled from that repository, never from the
# caller's current working directory or this script's own location.
#
# With no paths, prints only the repo-wide sample. With paths, prints a
# "commits touching changed paths" sample first, followed by the
# repo-wide sample. Changed-path history should be weighted more heavily
# than repo-wide history when the two disagree (e.g. a subsystem with
# its own subject prefix convention).
#
# Excludes merge commits and commits from known bot/automation authors
# so the sample reflects human-authored style, not generated noise.
# Sampling is a deterministic stride across a fixed scan window (not
# just "last N"), so a burst of similar commits from one author doesn't
# dominate the sample.

set -eu

REPO_SCAN=300 # commits to scan repo-wide before sampling
REPO_SAMPLE=12 # commits to keep from the repo-wide scan
PATH_SCAN=60 # commits to scan for the changed-path sample
PATH_SAMPLE=10 # commits to keep from the changed-path scan

# Known bot/automation identities only. Deliberately excludes generic
# "noreply"/"no-reply" patterns: GitHub and GitLab assign those to
# ordinary human contributors who keep their email private, and
# filtering them out would strip real history from the sample.
BOT_AUTHOR_RE='\[bot\]|bot@|\+gitlab@|github-actions|dependabot|renovate'

FORMAT='%x00%H%x1f%an <%ae>%x1f%ad%x1f%B'

REPO=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo)
            [ "$#" -ge 2 ] || { echo "sample-history: --repo requires a value" >&2; exit 2; }
            REPO=$2
            shift 2
            ;;
        --repo=*)
            REPO=${1#--repo=}
            shift
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "sample-history: unknown option: $1" >&2
            exit 2
            ;;
        *)
            break
            ;;
    esac
done

if [ -z "$REPO" ]; then
    echo "Usage: sample-history.sh --repo <repo-root> [<changed-path>...]" >&2
    exit 2
fi

if ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
    echo "sample-history: '$REPO' is not inside a git repository" >&2
    exit 1
fi

TMP_LOG=$(mktemp)
trap 'rm -f "$TMP_LOG"' EXIT

sample() {
    # $1 = commits to scan, $2 = commits to keep, remaining = pathspec (optional)
    scan=$1
    keep=$2
    shift 2
    if [ "$#" -gt 0 ]; then
        git -C "$REPO" log --no-merges -n "$scan" --format="$FORMAT" --date=short -- "$@" > "$TMP_LOG"
    else
        git -C "$REPO" log --no-merges -n "$scan" --format="$FORMAT" --date=short > "$TMP_LOG"
    fi

    KEEP="$keep" BOT_RE="$BOT_AUTHOR_RE" perl -0777 -ne '
        my $bot = qr/$ENV{BOT_RE}/i;
        my @records = split /\x00/, $_;
        shift @records if @records && $records[0] eq "";
        my @kept;
        for my $r (@records) {
            my ($hash, $author, $date, $body) = split /\x1f/, $r, 4;
            next if !defined($author) || $author =~ $bot;
            push @kept, [$hash, $author, $date, $body // ""];
        }
        my $n = scalar @kept;
        exit 0 if $n == 0;
        my $keep = $ENV{KEEP} + 0;
        my $stride = $n > $keep ? $n / $keep : 1;
        my $i = 0;
        my $printed = 0;
        while ($i < $n && $printed < $keep) {
            my $idx = int($i);
            my ($hash, $author, $date, $body) = @{ $kept[$idx] };
            $body =~ s/\s+\z//;
            print "=== " . substr($hash, 0, 10) . " | $author | $date ===\n$body\n\n";
            $printed++;
            $i += $stride;
        }
    ' < "$TMP_LOG"
}

if [ "$#" -gt 0 ]; then
    echo "## Commits touching changed paths"
    echo
    sample "$PATH_SCAN" "$PATH_SAMPLE" "$@"
    echo
fi

echo "## Repo-wide sample"
echo
sample "$REPO_SCAN" "$REPO_SAMPLE"
