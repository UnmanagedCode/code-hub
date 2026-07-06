import { execFile } from 'node:child_process';

// Termux's Node lacks util.promisify.custom on execFile (same quirk noted in
// code-conductor), so wrap it manually to get {stdout} back.
function run(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

// Current HEAD sha of a checkout (main or worktree). null if not a repo /
// git unavailable / dir gone.
export async function headSha(dir) {
  return run(dir, ['rev-parse', 'HEAD']);
}

// Short branch name of a checkout, or null on detached HEAD / error.
export async function currentBranch(dir) {
  const b = await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : null;
}

// ISO-8601 committer date of HEAD, or null (not a repo / no commits / git
// unavailable / dir gone).
export async function lastCommitAt(dir) {
  return run(dir, ['log', '-1', '--format=%cI']);
}
