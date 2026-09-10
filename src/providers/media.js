/**
 * Now playing, and transport control, without any music-service API.
 *
 * Every desktop already knows what is playing, because the OS owns the media keys.
 * Reading that beats the Spotify Web API four ways: no OAuth, no API key, it works
 * offline, and it covers every player rather than one -- Spotify, a browser tab, VLC.
 *
 * Windows  SMTC via GlobalSystemMediaTransportControlsSessionManager (WinRT)
 * macOS    AppleScript against a running player
 * Linux    MPRIS over D-Bus (playerctl)
 */
const { exec } = require("node:child_process");

const SEP = "\u001f";

const run = (cmd) =>
  new Promise((resolve) => {
    exec(cmd, { timeout: 2500 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });

const EMPTY = { title: null, artist: null, isPlaying: false, available: false };

async function readWindows() {
  // One PowerShell call returns the session as JSON. WinRT async methods are awaited
  // through AsTask() because PowerShell cannot await an IAsyncOperation directly.
  const ps = [
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime;",
    "$t=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync();",
    "$s=([System.WindowsRuntimeSystemExtensions]::AsTask($t)).Result.GetCurrentSession();",
    "if($null -eq $s){'{}';exit};",
    "$p=([System.WindowsRuntimeSystemExtensions]::AsTask($s.TryGetMediaPropertiesAsync())).Result;",
    "@{title=$p.Title;artist=$p.Artist;isPlaying=($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing')}|ConvertTo-Json -Compress",
  ].join(" ");
  const out = await run(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`);
  if (!out) return EMPTY;
  try {
    const j = JSON.parse(out);
    if (!j.title) return EMPTY;
    return { title: j.title, artist: j.artist ?? null, isPlaying: Boolean(j.isPlaying), available: true };
  } catch {
    return EMPTY;
  }
}

async function readLinux() {
  const out = await run(`playerctl metadata --format '{{title}}${SEP}{{artist}}${SEP}{{status}}'`);
  return parse(out);
}

async function readMac() {
  const osa = [
    'tell application "System Events" to set ns to name of every process',
    'if ns contains "Spotify" then',
    '  tell application "Spotify" to return (name of current track) & "\u001f" & (artist of current track) & "\u001f" & (player state as text)',
    'else if ns contains "Music" then',
    '  tell application "Music" to return (name of current track) & "\u001f" & (artist of current track) & "\u001f" & (player state as text)',
    "end if",
    'return ""',
  ].join("\n");
  return parse(await run(`osascript -e ${JSON.stringify(osa)}`));
}

function parse(out) {
  if (!out) return EMPTY;
  const [title, artist, state] = out.split(SEP);
  if (!title) return EMPTY;
  return {
    title,
    artist: artist || null,
    isPlaying: /playing/i.test(state ?? ""),
    available: true,
  };
}

const READERS = { win32: readWindows, linux: readLinux, darwin: readMac };

/** Transport control goes through the same OS layer, so it works for any player. */
async function control(action) {
  if (!["playpause", "next", "previous"].includes(action)) return false;
  if (process.platform === "linux") {
    const map = { playpause: "play-pause", next: "next", previous: "previous" };
    return (await run(`playerctl ${map[action]}`)) !== null;
  }
  if (process.platform === "darwin") {
    const map = { playpause: "playpause", next: "next track", previous: "previous track" };
    return (await run(`osascript -e 'tell application "Spotify" to ${map[action]}'`)) !== null;
  }
  // Windows: press the virtual media key. Every player already listens for it.
  const vk = { playpause: 0xb3, next: 0xb0, previous: 0xb1 }[action];
  const ps =
    "Add-Type -Name K -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, System.IntPtr e);';" +
    ` [N.K]::keybd_event(${vk},0,0,[System.IntPtr]::Zero)`;
  return (await run(`powershell -NoProfile -NonInteractive -Command "${ps}"`)) !== null;
}

const media = { name: "media", intervalMs: 2000, read: () => (READERS[process.platform] ?? (async () => EMPTY))() };

module.exports = { media, control };
