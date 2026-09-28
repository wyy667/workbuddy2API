'use strict';
// Full identity is used for token synchronization; display uid8 is never an identity.
function identity(session, siteOfDomain) {
  const uid = session?.account?.uid;
  return uid ? siteOfDomain(session.auth?.domain) + ':' + String(uid) : null;
}
function syncCredentialCopies({ fs, path, session, originalFile, archiveFile, activeFile, write, identify, report }) {
  const who = identify(session);
  if (!who) throw new Error('凭据缺少账号身份，不能安全更新 token');
  const targets = new Set([archiveFile]);
  for (const candidate of [originalFile, activeFile]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    // A user may have switched auth.json while the network refresh was in flight.
    const existing = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (identify(existing) === who) targets.add(candidate);
  }
  // Canonical archive first. Other copies can reconcile from it after a disk error.
  if (fs.existsSync(archiveFile) && identify(JSON.parse(fs.readFileSync(archiveFile, 'utf8'))) !== who) throw new Error('账号存档身份冲突，已阻止覆盖');
  write(archiveFile, session);
  for (const file of targets) {
    if (path.resolve(file) === path.resolve(archiveFile)) continue;
    const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (identify(existing) !== who) continue;
    try { write(file, { ...existing, auth: session.auth }); }
    catch (error) { report(file, error); throw error; }
  }
}
module.exports = { identity, syncCredentialCopies };
